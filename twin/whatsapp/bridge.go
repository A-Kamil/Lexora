package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/mdp/qrterminal/v3"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	wastore "go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

// Bridge tient la connexion WhatsApp (whatsmeow, protocole multi-device) et
// alimente le Store : historique à l'appairage, puis flux live.
type Bridge struct {
	cfg    Config
	log    *slog.Logger
	store  *Store
	client *whatsmeow.Client

	connected  atomic.Bool
	downSince  atomic.Int64 // epoch de la dernière déconnexion, 0 si connecté
	histConvs  atomic.Int64 // conversations reçues par history sync
	histMsgs   atomic.Int64 // messages insérés via history sync
	liveMsgs   atomic.Int64 // messages insérés via le flux live
	groupNames sync.Map     // jid string -> groupNameEntry ; GetGroupInfo coûte un aller-retour
	namesMu    sync.Mutex   // une seule passe de rattrapage des noms à la fois
	mediaQueue chan mediaJob
}

type groupNameEntry struct {
	name string
	at   time.Time
}

// Le gestionnaire d'événements de whatsmeow est synchrone : tout appel
// réseau qu'on y fait bloque la réception. Vu en prod : GetGroupInfo sur
// status@broadcast a gelé le flux 75 s. D'où ce délai court et le cache.
const groupInfoTimeout = 5 * time.Second
const groupInfoRetryAfter = 10 * time.Minute

func newBridge(ctx context.Context, cfg Config, log *slog.Logger, store *Store) (*Bridge, error) {
	sess, err := sql.Open("sqlite", sqliteDSN(filepath.Join(cfg.DataDir, "session.db")))
	if err != nil {
		return nil, err
	}
	// Le dialecte reste "sqlite3" (grammaire SQL) même avec le pilote modernc.
	container := sqlstore.NewWithDB(sess, "sqlite3", waLogger{log.With("module", "session")})
	if err := container.Upgrade(ctx); err != nil {
		return nil, fmt.Errorf("session.db : %w", err)
	}
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		return nil, err
	}
	// Ne s'applique qu'au moment de l'appairage : pour changer d'avis il faut
	// supprimer session.db et rescanner le QR.
	wastore.DeviceProps.RequireFullSync = proto.Bool(cfg.FullSync)
	if cfg.FullSync {
		// Sans ces plafonds, le téléphone n'envoie que l'historique récent
		// même avec RequireFullSync (constaté au 1er appairage : bloc FULL vide).
		wastore.DeviceProps.HistorySyncConfig.FullSyncDaysLimit = proto.Uint32(3650)
		wastore.DeviceProps.HistorySyncConfig.FullSyncSizeMbLimit = proto.Uint32(102400)
		wastore.DeviceProps.HistorySyncConfig.StorageQuotaMb = proto.Uint32(102400)
	}
	wastore.DeviceProps.Os = proto.String("twin-whatsapp")

	b := &Bridge{cfg: cfg, log: log, store: store, mediaQueue: make(chan mediaJob, 20000)}
	b.client = whatsmeow.NewClient(device, waLogger{log.With("module", "wa")})
	b.client.AddEventHandler(b.handle)
	return b, nil
}

// Connect appaire (QR sur stderr) si nécessaire puis se connecte. whatsmeow
// gère lui-même les reconnexions ensuite.
func (b *Bridge) Connect(ctx context.Context) error {
	if b.client.Store.ID != nil {
		return b.client.Connect()
	}
	qr, err := b.client.GetQRChannel(ctx)
	if err != nil {
		return err
	}
	if err := b.client.Connect(); err != nil {
		return err
	}
	b.log.Info("appairage requis : WhatsApp > Appareils connectés > Connecter un appareil")
	for item := range qr {
		switch item.Event {
		case "code":
			qrterminal.GenerateHalfBlock(item.Code, qrterminal.L, os.Stderr)
			b.log.Info("QR affiché", "expire_dans", item.Timeout.Round(time.Second))
		case "success":
			b.log.Info("appairage réussi")
		case "error":
			return fmt.Errorf("appairage : %w", item.Error)
		default:
			b.log.Warn("appairage : événement", "event", item.Event)
		}
	}
	return nil
}

func (b *Bridge) Disconnect() { b.client.Disconnect() }

// watchdog borne la reconnexion. whatsmeow attend 2 s × (nb d'échecs) entre
// deux tentatives, sans plafond : après une coupure réseau d'une heure
// (veille du portable), il peut rester muet 1 h de plus alors que le réseau
// est revenu — constaté le 2026-09-06 (78 min). Connect() pendant sa pause
// est sûr : sa propre tentative recevra ErrAlreadyConnected et s'arrêtera.
func (b *Bridge) watchdog(ctx context.Context) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		since := b.downSince.Load()
		if since == 0 || b.client.Store.ID == nil || b.client.IsConnected() {
			continue
		}
		down := time.Since(time.Unix(since, 0))
		if down < time.Minute {
			continue
		}
		b.log.Warn("toujours déconnecté, reconnexion forcée", "depuis", down.Round(time.Second))
		if err := b.client.Connect(); err != nil && !errors.Is(err, whatsmeow.ErrAlreadyConnected) {
			b.log.Warn("reconnexion forcée échouée", "err", err)
		}
	}
}

func (b *Bridge) handle(evt any) {
	ctx := context.Background()
	switch e := evt.(type) {
	case *events.Connected:
		b.connected.Store(true)
		b.downSince.Store(0)
		b.log.Info("connecté à WhatsApp")
		// Les push names arrivent quelques secondes après la connexion.
		time.AfterFunc(30*time.Second, func() { b.refreshNames(ctx) })
	case *events.Disconnected:
		b.connected.Store(false)
		b.downSince.CompareAndSwap(0, time.Now().Unix())
		b.log.Warn("déconnecté — reconnexion automatique")
	case *events.OfflineSyncPreview:
		b.log.Info("rattrapage hors-ligne annoncé", "messages", e.Messages, "total", e.Total)
	case *events.OfflineSyncCompleted:
		b.log.Info("rattrapage hors-ligne terminé", "événements", e.Count)
	case *events.LoggedOut:
		b.connected.Store(false)
		b.log.Error("session révoquée par WhatsApp : supprimer session.db et ré-appairer",
			"reason", e.Reason)
	case *events.Message:
		if ok := b.storeMessage(ctx, e, ""); ok {
			b.liveMsgs.Add(1)
		}
	case *events.HistorySync:
		// Les blocs d'historique sont gros : hors du fil d'événements.
		go b.handleHistory(ctx, e)
	case *events.CallOffer, *events.CallOfferNotice, *events.CallAccept, *events.CallReject, *events.CallTerminate:
		b.handleCall(ctx, e)
	}
}

func (b *Bridge) handleHistory(ctx context.Context, e *events.HistorySync) {
	convs := e.Data.GetConversations()
	var inserted int64
	for _, conv := range convs {
		jid, err := types.ParseJID(conv.GetID())
		if err != nil {
			continue
		}
		name := conv.GetName()
		if name == "" {
			name = conv.GetDisplayName()
		}
		for _, hm := range conv.GetMessages() {
			evt, err := b.client.ParseWebMessage(jid, hm.GetMessage())
			if err != nil {
				continue
			}
			if b.storeMessage(ctx, evt, name) {
				inserted++
			}
		}
	}
	b.histConvs.Add(int64(len(convs)))
	b.histMsgs.Add(inserted)
	b.log.Info("bloc d'historique traité", "type", e.Data.GetSyncType().String(),
		"conversations", len(convs), "nouveaux_messages", inserted)
	if inserted > 0 {
		b.refreshNames(ctx)
	}
}

// refreshNames complète les chats et expéditeurs stockés sans nom, à partir
// du carnet de contacts tel qu'il est connu maintenant.
func (b *Bridge) refreshNames(ctx context.Context) {
	if !b.namesMu.TryLock() {
		return
	}
	defer b.namesMu.Unlock()
	var fixedChats, fixedSenders int
	jids, err := b.store.ChatsWithoutName(ctx)
	if err != nil {
		b.log.Error("rattrapage noms", "err", err)
		return
	}
	for _, raw := range jids {
		jid, err := types.ParseJID(raw)
		if err != nil {
			continue
		}
		var name string
		if jid.Server == types.GroupServer {
			name = b.groupName(ctx, jid)
		} else {
			name = b.contactName(ctx, jid)
		}
		if name != "" && b.store.SetChatName(ctx, raw, name) == nil {
			fixedChats++
		}
	}
	senders, err := b.store.SendersWithoutName(ctx)
	if err != nil {
		return
	}
	for _, raw := range senders {
		jid, err := types.ParseJID(raw)
		if err != nil {
			continue
		}
		if name := b.contactName(ctx, jid); name != "" && b.store.SetSenderName(ctx, raw, name) == nil {
			fixedSenders++
		}
	}
	if fixedChats+fixedSenders > 0 {
		b.log.Info("noms complétés", "chats", fixedChats, "expéditeurs", fixedSenders,
			"chats_restants_sans_nom", len(jids)-fixedChats)
	}
}

// storeMessage normalise un message (live ou historique) et l'insère.
// Retourne true si la ligne est nouvelle. Ne journalise jamais le texte.
func (b *Bridge) storeMessage(ctx context.Context, evt *events.Message, chatName string) bool {
	info := evt.Info
	// Statuts (stories) et chaînes : pas des conversations, et status@broadcast
	// est marqué IsGroup sans être un groupe.
	if info.Chat.Server == types.BroadcastServer || info.Chat.Server == types.NewsletterServer {
		return false
	}
	if b.callFromHistory(ctx, evt) {
		return false // journal d'appel, rangé dans calls
	}
	text, media := extractText(evt.Message)
	if text == "" && media == "" {
		return false
	}
	chat := b.canonical(ctx, info.Chat)
	if chatName == "" {
		chatName = b.chatName(ctx, chat, info)
	}
	sender := b.canonical(ctx, info.Sender)
	senderName := "moi"
	if !info.IsFromMe {
		senderName = b.contactName(ctx, sender)
		if senderName == "" {
			senderName = info.PushName
		}
	}
	ts := info.Timestamp.Unix()
	if err := b.store.UpsertChat(ctx, chat.String(), chatName, info.IsGroup, ts); err != nil {
		b.log.Error("upsert chat", "err", err)
		return false
	}
	ok, err := b.store.InsertMsg(ctx, Msg{
		ID: string(info.ID), ChatJID: chat.String(), Sender: sender.String(),
		SenderName: senderName, TS: ts, FromMe: info.IsFromMe, Text: text, Media: media,
	})
	if err != nil {
		b.log.Error("insert message", "err", err)
		return false
	}
	if media == "vocal" || media == "audio" {
		b.enqueueVoice(ctx, chat.String(), string(info.ID), unwrapAudio(evt.Message))
	}
	return ok
}

// canonical ramène un identifiant LID (adressage anonymisé récent) vers le
// numéro de téléphone quand la correspondance est connue, pour qu'un même
// contact n'apparaisse pas sous deux JID.
func (b *Bridge) canonical(ctx context.Context, jid types.JID) types.JID {
	if jid.Server == types.HiddenUserServer {
		if pn, err := b.client.Store.LIDs.GetPNForLID(ctx, jid); err == nil && !pn.IsEmpty() {
			return pn.ToNonAD()
		}
	}
	return jid.ToNonAD()
}

func (b *Bridge) chatName(ctx context.Context, chat types.JID, info types.MessageInfo) string {
	if chat.Server == types.GroupServer {
		return b.groupName(ctx, chat)
	}
	if n := b.contactName(ctx, chat); n != "" {
		return n
	}
	// En DM, le pushName d'un message reçu est celui de l'interlocuteur ; sur
	// un message envoyé par moi, ce serait le mien — on l'ignore alors.
	if !info.IsFromMe {
		return info.PushName
	}
	return ""
}

// groupName interroge le serveur avec un délai borné et mémorise aussi les
// échecs, pour ne pas payer le délai à chaque message d'un groupe injoignable.
func (b *Bridge) groupName(ctx context.Context, jid types.JID) string {
	key := jid.String()
	if v, ok := b.groupNames.Load(key); ok {
		e := v.(groupNameEntry)
		if e.name != "" || time.Since(e.at) < groupInfoRetryAfter {
			return e.name
		}
	}
	tctx, cancel := context.WithTimeout(ctx, groupInfoTimeout)
	defer cancel()
	name := ""
	if g, err := b.client.GetGroupInfo(tctx, jid); err == nil {
		name = g.Name
	}
	b.groupNames.Store(key, groupNameEntry{name: name, at: time.Now()})
	return name
}

func (b *Bridge) contactName(ctx context.Context, jid types.JID) string {
	c, err := b.client.Store.Contacts.GetContact(ctx, jid)
	if err != nil || !c.Found {
		return ""
	}
	switch {
	case c.FullName != "":
		return c.FullName
	case c.FirstName != "":
		return c.FirstName
	case c.PushName != "":
		return c.PushName
	default:
		return c.BusinessName
	}
}

// Send envoie un texte. L'exposition de cet appel est conditionnée par
// TWIN_WA_ALLOW_SEND ; la confirmation humaine (HITL) est du ressort du
// gateway, jamais de ce connecteur.
func (b *Bridge) Send(ctx context.Context, to types.JID, text string) error {
	_, err := b.client.SendMessage(ctx, to, &waE2E.Message{Conversation: proto.String(text)})
	return err
}

// extractText rend (texte, type de média). Les réactions, accusés et messages
// de protocole n'apportent aucun fait et sont ignorés (retour vide).
func extractText(m *waE2E.Message) (string, string) {
	if m == nil {
		return "", ""
	}
	// Enveloppes : éphémère, vue unique, édition — le vrai message est dedans.
	for _, w := range []*waE2E.FutureProofMessage{
		m.GetEphemeralMessage(), m.GetViewOnceMessage(), m.GetEditedMessage(),
		m.GetDocumentWithCaptionMessage(),
	} {
		if w != nil && w.GetMessage() != nil {
			return extractText(w.GetMessage())
		}
	}
	switch {
	case m.GetConversation() != "":
		return m.GetConversation(), ""
	case m.GetExtendedTextMessage() != nil:
		return m.GetExtendedTextMessage().GetText(), ""
	case m.GetImageMessage() != nil:
		return m.GetImageMessage().GetCaption(), "image"
	case m.GetVideoMessage() != nil:
		return m.GetVideoMessage().GetCaption(), "video"
	case m.GetAudioMessage() != nil:
		if m.GetAudioMessage().GetPTT() {
			return "", "vocal"
		}
		return "", "audio"
	case m.GetDocumentMessage() != nil:
		d := m.GetDocumentMessage()
		if d.GetCaption() != "" {
			return d.GetCaption(), "document"
		}
		return d.GetFileName(), "document"
	case m.GetStickerMessage() != nil:
		return "", "sticker"
	case m.GetLocationMessage() != nil:
		l := m.GetLocationMessage()
		return fmt.Sprintf("%s %.5f,%.5f", l.GetName(), l.GetDegreesLatitude(), l.GetDegreesLongitude()), "location"
	case m.GetContactMessage() != nil:
		return m.GetContactMessage().GetDisplayName(), "contact"
	}
	return "", ""
}

// unwrapAudio retrouve l'AudioMessage, y compris sous une enveloppe éphémère.
func unwrapAudio(m *waE2E.Message) *waE2E.AudioMessage {
	if m == nil {
		return nil
	}
	if a := m.GetAudioMessage(); a != nil {
		return a
	}
	for _, w := range []*waE2E.FutureProofMessage{m.GetEphemeralMessage(), m.GetViewOnceMessage()} {
		if w != nil && w.GetMessage() != nil {
			if a := w.GetMessage().GetAudioMessage(); a != nil {
				return a
			}
		}
	}
	return nil
}

func fmtTS(ts int64) string {
	if ts == 0 {
		return ""
	}
	return time.Unix(ts, 0).Local().Format("2006-01-02 15:04")
}
