package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"go.mau.fi/whatsmeow/types"
)

const version = "0.1.0"

// Les annotations disent au gateway ce qu'un outil peut faire ; c'est lui qui
// applique la règle « write ⇒ HITL ».
var readOnly = &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: ptr(false)}

func ptr[T any](v T) *T { return &v }

func newMCPServer(b *Bridge, cfg Config) *mcp.Server {
	srv := mcp.NewServer(&mcp.Implementation{Name: "twin-whatsapp", Version: version}, nil)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "list_chats", Annotations: readOnly,
		Description: "Liste les conversations WhatsApp, les plus récentes d'abord. " +
			"Filtre optionnel sur le nom du contact/groupe.",
	}, b.toolListChats)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "get_messages", Annotations: readOnly,
		Description: "Derniers messages d'une conversation (nom de contact/groupe ou JID). " +
			"Pour remonter plus loin, passer `before` = `at` du plus ancien message reçu.",
	}, b.toolGetMessages)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "search_messages", Annotations: readOnly,
		Description: "Recherche plein texte dans tous les messages (accents ignorés, tous les " +
			"mots doivent apparaître). Filtres optionnels : conversation, dates.",
	}, b.toolSearch)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "list_calls", Annotations: readOnly,
		Description: "Journal des appels WhatsApp (audio/vidéo, entrants/sortants, manqués), les plus " +
			"récents d'abord. Filtres : correspondant (nom ou JID), dates.",
	}, b.toolListCalls)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "call_stats", Annotations: readOnly,
		Description: "Statistiques d'appels sur une période : volumes par sens/issue/média, minutes, " +
			"répartition par heure et jour de semaine, correspondants les plus appelés.",
	}, b.toolCallStats)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "voice_notes", Annotations: readOnly,
		Description: "Notes vocales (avec transcription quand elle existe), les plus récentes d'abord. " +
			"Filtres : conversation, dates.",
	}, b.toolVoiceNotes)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "sync_status", Annotations: readOnly,
		Description: "État de la connexion WhatsApp et volume du miroir local.",
	}, b.toolStatus)

	if cfg.AllowSend {
		mcp.AddTool(srv, &mcp.Tool{
			Name: "send_message",
			Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false, DestructiveHint: ptr(false),
				OpenWorldHint: ptr(true)},
			Description: "Envoie un message texte WhatsApp. ACTION D'ÉCRITURE : ne jamais " +
				"appeler sans confirmation humaine explicite obtenue par le gateway.",
		}, b.toolSend)
	}
	return srv
}

// ---- entrées / sorties typées (le SDK en dérive les schémas JSON) ----

type listChatsIn struct {
	Query string `json:"query,omitempty" jsonschema:"filtre sur le nom (sous-chaîne, insensible à la casse)"`
	Limit int    `json:"limit,omitempty" jsonschema:"nombre max de conversations (défaut 30)"`
}
type listChatsOut struct {
	Chats []Chat `json:"chats"`
}

type getMessagesIn struct {
	Chat   string `json:"chat" jsonschema:"nom du contact/groupe ou JID (ex. 336…@s.whatsapp.net)"`
	Limit  int    `json:"limit,omitempty" jsonschema:"nombre max de messages (défaut 50)"`
	Before string `json:"before,omitempty" jsonschema:"ne renvoyer que les messages antérieurs à cette date (YYYY-MM-DD ou YYYY-MM-DD HH:MM)"`
}
type messagesOut struct {
	Chat     *Chat `json:"chat,omitempty"`
	Messages []Msg `json:"messages"`
}

type searchIn struct {
	Query  string `json:"query" jsonschema:"mots à chercher"`
	Chat   string `json:"chat,omitempty" jsonschema:"restreindre à une conversation (nom ou JID)"`
	After  string `json:"after,omitempty" jsonschema:"date plancher (YYYY-MM-DD)"`
	Before string `json:"before,omitempty" jsonschema:"date plafond (YYYY-MM-DD)"`
	Limit  int    `json:"limit,omitempty" jsonschema:"nombre max de résultats (défaut 30)"`
}

type listCallsIn struct {
	Peer   string `json:"peer,omitempty" jsonschema:"correspondant : nom du contact/groupe ou JID"`
	After  string `json:"after,omitempty" jsonschema:"date plancher (YYYY-MM-DD)"`
	Before string `json:"before,omitempty" jsonschema:"date plafond (YYYY-MM-DD)"`
	Limit  int    `json:"limit,omitempty" jsonschema:"nombre max (défaut 50)"`
}
type listCallsOut struct {
	Calls []Call `json:"calls"`
}
type callStatsIn struct {
	After  string `json:"after,omitempty" jsonschema:"date plancher (YYYY-MM-DD)"`
	Before string `json:"before,omitempty" jsonschema:"date plafond (YYYY-MM-DD)"`
	Top    int    `json:"top,omitempty" jsonschema:"nombre de correspondants dans le classement (défaut 10)"`
}

type voiceNotesIn struct {
	Chat   string `json:"chat,omitempty" jsonschema:"conversation (nom ou JID)"`
	After  string `json:"after,omitempty" jsonschema:"date plancher (YYYY-MM-DD)"`
	Before string `json:"before,omitempty" jsonschema:"date plafond (YYYY-MM-DD)"`
	Limit  int    `json:"limit,omitempty" jsonschema:"nombre max (défaut 30)"`
}
type voiceNotesOut struct {
	Notes []VoiceNote `json:"notes"`
}

type statusOut struct {
	Connected    bool   `json:"connected"`
	Paired       bool   `json:"paired"`
	HistoryConvs int64  `json:"history_conversations"`
	HistoryMsgs  int64  `json:"history_messages"`
	LiveMsgs     int64  `json:"live_messages"`
	Store        Stats  `json:"store"`
	SendEnabled  bool   `json:"send_enabled"`
	Version      string `json:"version"`
}

type sendIn struct {
	Chat string `json:"chat" jsonschema:"destinataire : nom du contact/groupe ou JID"`
	Text string `json:"text" jsonschema:"texte à envoyer"`
}
type sendOut struct {
	To   string `json:"to"`
	Sent bool   `json:"sent"`
}

// ---- handlers ----

func (b *Bridge) toolListChats(ctx context.Context, _ *mcp.CallToolRequest, in listChatsIn) (*mcp.CallToolResult, listChatsOut, error) {
	chats, err := b.store.ListChats(ctx, in.Query, clampLimit(in.Limit, 30, 200))
	if err != nil {
		return toolErr(err), listChatsOut{}, nil
	}
	return nil, listChatsOut{Chats: orEmptyChats(chats)}, nil
}

func (b *Bridge) toolGetMessages(ctx context.Context, _ *mcp.CallToolRequest, in getMessagesIn) (*mcp.CallToolResult, messagesOut, error) {
	chat, err := b.resolveChat(ctx, in.Chat)
	if err != nil {
		return toolErr(err), messagesOut{}, nil
	}
	before, err := parseDate(in.Before, true)
	if err != nil {
		return toolErr(err), messagesOut{}, nil
	}
	msgs, err := b.store.Messages(ctx, chat.JID, before, clampLimit(in.Limit, 50, 500))
	if err != nil {
		return toolErr(err), messagesOut{}, nil
	}
	return nil, messagesOut{Chat: chat, Messages: orEmptyMsgs(msgs)}, nil
}

func (b *Bridge) toolSearch(ctx context.Context, _ *mcp.CallToolRequest, in searchIn) (*mcp.CallToolResult, messagesOut, error) {
	if strings.TrimSpace(in.Query) == "" {
		return toolErr(fmt.Errorf("query vide")), messagesOut{}, nil
	}
	var chatJID string
	var chat *Chat
	if in.Chat != "" {
		c, err := b.resolveChat(ctx, in.Chat)
		if err != nil {
			return toolErr(err), messagesOut{}, nil
		}
		chat, chatJID = c, c.JID
	}
	after, err := parseDate(in.After, false)
	if err != nil {
		return toolErr(err), messagesOut{}, nil
	}
	before, err := parseDate(in.Before, true)
	if err != nil {
		return toolErr(err), messagesOut{}, nil
	}
	msgs, err := b.store.Search(ctx, in.Query, chatJID, after, before, clampLimit(in.Limit, 30, 200))
	if err != nil {
		return toolErr(err), messagesOut{}, nil
	}
	return nil, messagesOut{Chat: chat, Messages: orEmptyMsgs(msgs)}, nil
}

func (b *Bridge) toolListCalls(ctx context.Context, _ *mcp.CallToolRequest, in listCallsIn) (*mcp.CallToolResult, listCallsOut, error) {
	peer := ""
	if in.Peer != "" {
		c, err := b.resolveChat(ctx, in.Peer)
		if err != nil {
			return toolErr(err), listCallsOut{}, nil
		}
		peer = c.JID
	}
	after, err := parseDate(in.After, false)
	if err != nil {
		return toolErr(err), listCallsOut{}, nil
	}
	before, err := parseDate(in.Before, true)
	if err != nil {
		return toolErr(err), listCallsOut{}, nil
	}
	calls, err := b.store.ListCalls(ctx, peer, after, before, clampLimit(in.Limit, 50, 500))
	if err != nil {
		return toolErr(err), listCallsOut{}, nil
	}
	if calls == nil {
		calls = []Call{}
	}
	return nil, listCallsOut{Calls: calls}, nil
}

func (b *Bridge) toolCallStats(ctx context.Context, _ *mcp.CallToolRequest, in callStatsIn) (*mcp.CallToolResult, CallStats, error) {
	after, err := parseDate(in.After, false)
	if err != nil {
		return toolErr(err), CallStats{}, nil
	}
	before, err := parseDate(in.Before, true)
	if err != nil {
		return toolErr(err), CallStats{}, nil
	}
	st, err := b.store.CallStats(ctx, after, before, clampLimit(in.Top, 10, 50))
	if err != nil {
		return toolErr(err), CallStats{}, nil
	}
	return nil, st, nil
}

func (b *Bridge) toolVoiceNotes(ctx context.Context, _ *mcp.CallToolRequest, in voiceNotesIn) (*mcp.CallToolResult, voiceNotesOut, error) {
	chat := ""
	if in.Chat != "" {
		c, err := b.resolveChat(ctx, in.Chat)
		if err != nil {
			return toolErr(err), voiceNotesOut{}, nil
		}
		chat = c.JID
	}
	after, err := parseDate(in.After, false)
	if err != nil {
		return toolErr(err), voiceNotesOut{}, nil
	}
	before, err := parseDate(in.Before, true)
	if err != nil {
		return toolErr(err), voiceNotesOut{}, nil
	}
	notes, err := b.store.VoiceNotes(ctx, chat, after, before, clampLimit(in.Limit, 30, 300))
	if err != nil {
		return toolErr(err), voiceNotesOut{}, nil
	}
	if notes == nil {
		notes = []VoiceNote{}
	}
	return nil, voiceNotesOut{Notes: notes}, nil
}

func (b *Bridge) toolStatus(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, statusOut, error) {
	st, err := b.store.Stats(ctx)
	if err != nil {
		return toolErr(err), statusOut{}, nil
	}
	return nil, statusOut{
		Connected: b.connected.Load(), Paired: b.client.Store.ID != nil,
		HistoryConvs: b.histConvs.Load(), HistoryMsgs: b.histMsgs.Load(),
		LiveMsgs: b.liveMsgs.Load(), Store: st, SendEnabled: b.cfg.AllowSend, Version: version,
	}, nil
}

func (b *Bridge) toolSend(ctx context.Context, _ *mcp.CallToolRequest, in sendIn) (*mcp.CallToolResult, sendOut, error) {
	if strings.TrimSpace(in.Text) == "" {
		return toolErr(fmt.Errorf("text vide")), sendOut{}, nil
	}
	chat, err := b.resolveChat(ctx, in.Chat)
	if err != nil {
		return toolErr(err), sendOut{}, nil
	}
	jid, err := types.ParseJID(chat.JID)
	if err != nil {
		return toolErr(err), sendOut{}, nil
	}
	if err := b.Send(ctx, jid, in.Text); err != nil {
		return toolErr(err), sendOut{To: chat.JID}, nil
	}
	b.log.Info("message envoyé", "chat", chat.JID, "chars", len(in.Text))
	return nil, sendOut{To: chat.JID, Sent: true}, nil
}

// ---- utilitaires ----

// resolveChat accepte un JID exact ou un nom ; une ambiguïté est une erreur
// explicite plutôt qu'un choix silencieux.
func (b *Bridge) resolveChat(ctx context.Context, ref string) (*Chat, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return nil, fmt.Errorf("chat vide")
	}
	if strings.Contains(ref, "@") {
		jid, err := types.ParseJID(ref)
		if err != nil {
			return nil, fmt.Errorf("JID invalide : %w", err)
		}
		jid = b.canonical(ctx, jid)
		chats, err := b.store.ListChats(ctx, jid.String(), 1)
		if err != nil {
			return nil, err
		}
		if len(chats) == 1 && chats[0].JID == jid.String() {
			return &chats[0], nil
		}
		return &Chat{JID: jid.String(), Name: jid.User, IsGroup: jid.Server == types.GroupServer}, nil
	}
	chats, err := b.store.ListChats(ctx, ref, 6)
	if err != nil {
		return nil, err
	}
	switch len(chats) {
	case 0:
		return nil, fmt.Errorf("aucune conversation ne correspond à « %s »", ref)
	case 1:
		return &chats[0], nil
	}
	// Correspondance exacte sur le nom → pas d'ambiguïté.
	for i := range chats {
		if strings.EqualFold(chats[i].Name, ref) {
			return &chats[i], nil
		}
	}
	names := make([]string, 0, len(chats))
	for _, c := range chats {
		names = append(names, fmt.Sprintf("%s (%s)", c.Name, c.JID))
	}
	return nil, fmt.Errorf("« %s » est ambigu : %s", ref, strings.Join(names, " ; "))
}

// parseDate accepte YYYY-MM-DD ou YYYY-MM-DD HH:MM en heure locale. Une date
// seule utilisée comme plafond couvre la journée entière.
func parseDate(s string, endOfDay bool) (int64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, nil
	}
	if t, err := time.ParseInLocation("2006-01-02 15:04", s, time.Local); err == nil {
		return t.Unix(), nil
	}
	t, err := time.ParseInLocation("2006-01-02", s, time.Local)
	if err != nil {
		return 0, fmt.Errorf("date invalide « %s » (attendu YYYY-MM-DD ou YYYY-MM-DD HH:MM)", s)
	}
	if endOfDay {
		t = t.Add(24*time.Hour - time.Second)
	}
	return t.Unix(), nil
}

func clampLimit(n, def, max int) int {
	if n <= 0 {
		return def
	}
	if n > max {
		return max
	}
	return n
}

func toolErr(err error) *mcp.CallToolResult {
	return &mcp.CallToolResult{IsError: true,
		Content: []mcp.Content{&mcp.TextContent{Text: err.Error()}}}
}

func orEmptyChats(c []Chat) []Chat {
	if c == nil {
		return []Chat{}
	}
	return c
}
func orEmptyMsgs(m []Msg) []Msg {
	if m == nil {
		return []Msg{}
	}
	return m
}
