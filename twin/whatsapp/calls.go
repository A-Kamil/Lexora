package main

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	waBinary "go.mau.fi/whatsmeow/binary"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

// Journal des appels. Deux sources qui ne se recoupent pas :
//   - live      : événements CallOffer/Accept/Terminate/Reject reçus par
//                 l'appareil lié (un appel = 2 à 3 événements, même CallID) ;
//   - history   : CallLogMessage (appels récents, avec durée et issue) et
//                 stubs CALL_MISSED_* (anciens exports) dans l'historique.

const callsSchema = `
CREATE TABLE IF NOT EXISTS calls (
  id          TEXT PRIMARY KEY,
  chat_jid    TEXT NOT NULL,
  peer        TEXT NOT NULL,
  peer_name   TEXT NOT NULL DEFAULT '',
  direction   TEXT NOT NULL,            -- in | out
  media       TEXT NOT NULL,            -- voice | video
  outcome     TEXT NOT NULL,            -- connected | missed | rejected | failed | ongoing | unknown
  started_ts  INTEGER NOT NULL,
  answered_ts INTEGER,
  ended_ts    INTEGER,
  duration_s  INTEGER NOT NULL DEFAULT 0,
  is_group    INTEGER NOT NULL DEFAULT 0,
  source      TEXT NOT NULL             -- live | history
);
CREATE INDEX IF NOT EXISTS calls_started ON calls(started_ts DESC);
CREATE INDEX IF NOT EXISTS calls_peer ON calls(peer, started_ts DESC);
`

type Call struct {
	ID        string `json:"id"`
	ChatJID   string `json:"chat_jid"`
	Peer      string `json:"peer"`
	PeerName  string `json:"peer_name,omitempty"`
	Direction string `json:"direction"`
	Media     string `json:"media"`
	Outcome   string `json:"outcome"`
	StartedTS int64  `json:"-"`
	Started   string `json:"started_at"`
	Answered  int64  `json:"-"`
	Ended     int64  `json:"-"`
	Duration  int64  `json:"duration_s"`
	IsGroup   bool   `json:"is_group"`
	Source    string `json:"source"`
}

func (s *Store) UpsertCall(ctx context.Context, c Call) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO calls(id, chat_jid, peer, peer_name, direction, media, outcome, started_ts,
                  answered_ts, ended_ts, duration_s, is_group, source)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULLIF(?, 0), NULLIF(?, 0), ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  peer_name   = CASE WHEN excluded.peer_name <> '' THEN excluded.peer_name ELSE calls.peer_name END,
  outcome     = CASE WHEN excluded.outcome <> 'unknown' THEN excluded.outcome ELSE calls.outcome END,
  answered_ts = COALESCE(excluded.answered_ts, calls.answered_ts),
  ended_ts    = COALESCE(excluded.ended_ts, calls.ended_ts),
  duration_s  = MAX(calls.duration_s, excluded.duration_s),
  media       = CASE WHEN excluded.media = 'video' THEN 'video' ELSE calls.media END`,
		c.ID, c.ChatJID, c.Peer, c.PeerName, c.Direction, c.Media, c.Outcome, c.StartedTS,
		c.Answered, c.Ended, c.Duration, c.IsGroup, c.Source)
	return err
}

// callAnswered / callEnded complètent un appel live déjà inséré par l'offre.
func (s *Store) callAnswered(ctx context.Context, id string, ts int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE calls SET answered_ts = ?, outcome = 'ongoing'
WHERE id = ? AND answered_ts IS NULL`, ts, id)
	return err
}

func (s *Store) callEnded(ctx context.Context, id string, ts int64, outcomeIfUnanswered string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE calls SET
  ended_ts   = COALESCE(ended_ts, ?),
  duration_s = CASE WHEN answered_ts IS NOT NULL THEN MAX(duration_s, ? - answered_ts) ELSE duration_s END,
  outcome    = CASE WHEN answered_ts IS NOT NULL THEN 'connected' ELSE ? END
WHERE id = ?`, ts, ts, outcomeIfUnanswered, id)
	return err
}

func (s *Store) ListCalls(ctx context.Context, peer string, after, before int64, limit int) ([]Call, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, chat_jid, peer, peer_name, direction, media, outcome, started_ts,
       COALESCE(answered_ts, 0), COALESCE(ended_ts, 0), duration_s, is_group, source
FROM calls
WHERE (? = '' OR peer = ? OR chat_jid = ?)
  AND (? = 0 OR started_ts >= ?) AND (? = 0 OR started_ts <= ?)
ORDER BY started_ts DESC LIMIT ?`, peer, peer, peer, after, after, before, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Call
	for rows.Next() {
		var c Call
		if err := rows.Scan(&c.ID, &c.ChatJID, &c.Peer, &c.PeerName, &c.Direction, &c.Media,
			&c.Outcome, &c.StartedTS, &c.Answered, &c.Ended, &c.Duration, &c.IsGroup, &c.Source); err != nil {
			return nil, err
		}
		c.Started = fmtTS(c.StartedTS)
		out = append(out, c)
	}
	return out, rows.Err()
}

type CallStats struct {
	Period       string         `json:"period"`
	Total        int            `json:"total"`
	ByDirection  map[string]int `json:"by_direction"`
	ByOutcome    map[string]int `json:"by_outcome"`
	ByMedia      map[string]int `json:"by_media"`
	TotalMinutes float64        `json:"total_minutes"`
	AvgMinutes   float64        `json:"avg_minutes_connected"`
	LongestMin   float64        `json:"longest_minutes"`
	ByHour       map[string]int `json:"by_hour"`    // "00".."23" heure locale
	ByWeekday    map[string]int `json:"by_weekday"` // lun..dim
	TopPeers     []PeerStat     `json:"top_peers"`
}

type PeerStat struct {
	Peer     string  `json:"peer"`
	Name     string  `json:"name,omitempty"`
	Calls    int     `json:"calls"`
	Minutes  float64 `json:"minutes"`
	Missed   int     `json:"missed"`
	LastCall string  `json:"last_call"`
}

var weekdaysFR = []string{"dim", "lun", "mar", "mer", "jeu", "ven", "sam"}

func (s *Store) CallStats(ctx context.Context, after, before int64, top int) (CallStats, error) {
	st := CallStats{ByDirection: map[string]int{}, ByOutcome: map[string]int{}, ByMedia: map[string]int{},
		ByHour: map[string]int{}, ByWeekday: map[string]int{}, TopPeers: []PeerStat{}}
	st.Period = fmt.Sprintf("%s → %s", orAll(fmtTS(after)), orAll(fmtTS(before)))
	rows, err := s.db.QueryContext(ctx, `
SELECT direction, media, outcome, started_ts, duration_s FROM calls
WHERE (? = 0 OR started_ts >= ?) AND (? = 0 OR started_ts <= ?)`, after, after, before, before)
	if err != nil {
		return st, err
	}
	var connected int
	var totalSec, longest int64
	for rows.Next() {
		var dir, media, outcome string
		var ts, dur int64
		if err := rows.Scan(&dir, &media, &outcome, &ts, &dur); err != nil {
			rows.Close()
			return st, err
		}
		st.Total++
		st.ByDirection[dir]++
		st.ByMedia[media]++
		st.ByOutcome[outcome]++
		t := time.Unix(ts, 0).Local()
		st.ByHour[fmt.Sprintf("%02d", t.Hour())]++
		st.ByWeekday[weekdaysFR[t.Weekday()]]++
		if dur > 0 {
			connected++
			totalSec += dur
			if dur > longest {
				longest = dur
			}
		}
	}
	rows.Close()
	st.TotalMinutes = round1(float64(totalSec) / 60)
	st.LongestMin = round1(float64(longest) / 60)
	if connected > 0 {
		st.AvgMinutes = round1(float64(totalSec) / 60 / float64(connected))
	}
	prow, err := s.db.QueryContext(ctx, `
SELECT c.peer, COALESCE(NULLIF(MAX(c.peer_name), ''), NULLIF(MAX(ch.name), ''), ''),
       COUNT(*), SUM(c.duration_s), SUM(c.outcome = 'missed'), MAX(c.started_ts)
FROM calls c LEFT JOIN chats ch ON ch.jid = c.peer
WHERE (? = 0 OR c.started_ts >= ?) AND (? = 0 OR c.started_ts <= ?)
GROUP BY c.peer ORDER BY COUNT(*) DESC, SUM(c.duration_s) DESC LIMIT ?`, after, after, before, before, top)
	if err != nil {
		return st, err
	}
	defer prow.Close()
	for prow.Next() {
		var p PeerStat
		var sec, last int64
		if err := prow.Scan(&p.Peer, &p.Name, &p.Calls, &sec, &p.Missed, &last); err != nil {
			return st, err
		}
		p.Minutes = round1(float64(sec) / 60)
		p.LastCall = fmtTS(last)
		st.TopPeers = append(st.TopPeers, p)
	}
	return st, prow.Err()
}

func round1(f float64) float64 { return float64(int64(f*10+0.5)) / 10 }
func orAll(s string) string {
	if s == "" {
		return "…"
	}
	return s
}

// ---- côté bridge : événements live ----

func (b *Bridge) isMe(jid types.JID) bool {
	me := b.client.Store.ID
	if me == nil {
		return false
	}
	if jid.User == me.User {
		return true
	}
	return !b.client.Store.LID.IsEmpty() && jid.User == b.client.Store.LID.User
}

func (b *Bridge) callPeer(ctx context.Context, m types.BasicCallMeta) (peer types.JID, isGroup bool) {
	if !m.GroupJID.IsEmpty() {
		return m.GroupJID, true
	}
	// From est l'autre partie dans les deux sens ; sinon le créateur.
	p := m.From
	if p.IsEmpty() || b.isMe(p) {
		p = m.CallCreator
	}
	return b.canonical(ctx, p), false
}

func (b *Bridge) handleCall(ctx context.Context, evt any) {
	switch e := evt.(type) {
	case *events.CallOffer:
		peer, grp := b.callPeer(ctx, e.BasicCallMeta)
		b.storeCallOffer(ctx, e.BasicCallMeta, peer, grp, callMediaFromNode(e.Data))
	case *events.CallOfferNotice:
		peer, grp := b.callPeer(ctx, e.BasicCallMeta)
		media := "voice"
		if e.Media == "video" {
			media = "video"
		}
		b.storeCallOffer(ctx, e.BasicCallMeta, peer, grp, media)
	case *events.CallAccept:
		_ = b.store.callAnswered(ctx, e.CallID, e.Timestamp.Unix())
	case *events.CallReject:
		_ = b.store.callEnded(ctx, e.CallID, e.Timestamp.Unix(), "rejected")
	case *events.CallTerminate:
		outcome := "missed"
		switch strings.ToLower(e.Reason) {
		case "reject", "busy", "declined":
			outcome = "rejected"
		case "failure", "failed", "error":
			outcome = "failed"
		}
		_ = b.store.callEnded(ctx, e.CallID, e.Timestamp.Unix(), outcome)
	}
}

func (b *Bridge) storeCallOffer(ctx context.Context, m types.BasicCallMeta, peer types.JID, grp bool, media string) {
	dir := "in"
	if b.isMe(m.CallCreator) {
		dir = "out"
	}
	name := ""
	if grp {
		name = b.groupName(ctx, peer)
	} else {
		name = b.contactName(ctx, peer)
	}
	if err := b.store.UpsertCall(ctx, Call{
		ID: m.CallID, ChatJID: peer.String(), Peer: peer.String(), PeerName: name, Direction: dir,
		Media: media, Outcome: "unknown", StartedTS: m.Timestamp.Unix(), IsGroup: grp, Source: "live",
	}); err != nil {
		b.log.Error("call offer", "err", err)
	}
}

// callMediaFromNode : l'offre 1:1 contient un enfant <video> pour un appel vidéo.
func callMediaFromNode(n *waBinary.Node) string {
	if n != nil && n.GetChildByTag("video").Tag == "video" {
		return "video"
	}
	return "voice"
}

// ---- côté bridge : historique ----

// callFromHistory reconnaît un journal d'appel dans un message d'historique.
// Retourne true si le message en était un (et ne doit pas être stocké comme texte).
func (b *Bridge) callFromHistory(ctx context.Context, evt *events.Message) bool {
	info := evt.Info
	peer := b.canonical(ctx, info.Chat)
	name := ""
	if cl := evt.Message.GetCallLogMesssage(); cl != nil {
		media := "voice"
		if cl.GetIsVideo() {
			media = "video"
		}
		outcome := map[waE2E.CallLogMessage_CallOutcome]string{
			waE2E.CallLogMessage_CONNECTED: "connected", waE2E.CallLogMessage_MISSED: "missed",
			waE2E.CallLogMessage_FAILED: "failed", waE2E.CallLogMessage_REJECTED: "rejected",
			waE2E.CallLogMessage_ACCEPTED_ELSEWHERE: "connected", waE2E.CallLogMessage_ONGOING: "ongoing",
			waE2E.CallLogMessage_SILENCED_BY_DND: "missed", waE2E.CallLogMessage_SILENCED_UNKNOWN_CALLER: "missed",
		}[cl.GetCallOutcome()]
		if outcome == "" {
			outcome = "unknown"
		}
		dir := "in"
		if info.IsFromMe {
			dir = "out"
		}
		if info.IsGroup {
			name = b.groupName(ctx, peer)
		} else {
			name = b.contactName(ctx, peer)
		}
		_ = b.store.UpsertCall(ctx, Call{
			ID: string(info.ID), ChatJID: peer.String(), Peer: peer.String(), PeerName: name,
			Direction: dir, Media: media, Outcome: outcome, StartedTS: info.Timestamp.Unix(),
			Duration: cl.GetDurationSecs(), IsGroup: info.IsGroup, Source: "history",
		})
		return true
	}
	if evt.SourceWebMsg != nil {
		var media string
		switch evt.SourceWebMsg.GetMessageStubType() {
		case waWeb.WebMessageInfo_CALL_MISSED_VOICE, waWeb.WebMessageInfo_CALL_MISSED_GROUP_VOICE:
			media = "voice"
		case waWeb.WebMessageInfo_CALL_MISSED_VIDEO, waWeb.WebMessageInfo_CALL_MISSED_GROUP_VIDEO:
			media = "video"
		default:
			return false
		}
		if info.IsGroup {
			name = b.groupName(ctx, peer)
		} else {
			name = b.contactName(ctx, peer)
		}
		_ = b.store.UpsertCall(ctx, Call{
			ID: string(info.ID), ChatJID: peer.String(), Peer: peer.String(), PeerName: name,
			Direction: "in", Media: media, Outcome: "missed", StartedTS: info.Timestamp.Unix(),
			IsGroup: info.IsGroup, Source: "history",
		})
		return true
	}
	return false
}

var _ = sql.ErrNoRows
