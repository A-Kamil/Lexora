package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
)

// Téléchargement des notes vocales, pour transcription (transcribe/).
// Hors du fil d'événements : une file + un seul téléchargeur, cadencé, pour
// ne pas noyer les serveurs WhatsApp pendant un history sync.

const mediaSchema = `
CREATE TABLE IF NOT EXISTS transcripts (
  chat_jid    TEXT NOT NULL,
  msg_id      TEXT NOT NULL,
  text        TEXT NOT NULL,
  language    TEXT NOT NULL DEFAULT '',
  model       TEXT NOT NULL DEFAULT '',
  duration_s  REAL NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (chat_jid, msg_id)
);
-- La transcription remplace le texte du message : elle devient cherchable
-- (FTS) et visible par tous les outils sans code spécial.
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
`

// migrate ajoute les colonnes apparues après la v0.1 (ALTER TABLE idempotent).
func (s *Store) migrate(ctx context.Context) error {
	for _, col := range []string{
		"media_path TEXT NOT NULL DEFAULT ''",
		"media_seconds INTEGER NOT NULL DEFAULT 0",
	} {
		name := strings.Fields(col)[0]
		var n int
		if err := s.db.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name = ?`, name).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			if _, err := s.db.ExecContext(ctx, `ALTER TABLE messages ADD COLUMN `+col); err != nil {
				return err
			}
		}
	}
	_, err := s.db.ExecContext(ctx, mediaSchema)
	return err
}

func (s *Store) MediaPath(ctx context.Context, chat, id string) (string, error) {
	var p string
	err := s.db.QueryRowContext(ctx, `SELECT media_path FROM messages WHERE chat_jid = ? AND id = ?`, chat, id).Scan(&p)
	return p, err
}

func (s *Store) SetMedia(ctx context.Context, chat, id, path string, seconds int) error {
	_, err := s.db.ExecContext(ctx, `UPDATE messages SET media_path = ?, media_seconds = MAX(media_seconds, ?)
WHERE chat_jid = ? AND id = ?`, path, seconds, chat, id)
	return err
}

type VoiceNote struct {
	Msg
	Seconds    int    `json:"seconds"`
	Downloaded bool   `json:"downloaded"`
	Transcript string `json:"transcript,omitempty"`
}

func (s *Store) VoiceNotes(ctx context.Context, chatJID string, after, before int64, limit int) ([]VoiceNote, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT m.id, m.chat_jid, COALESCE(c.name, ''), m.sender, m.sender_name, m.ts, m.from_me, m.text,
       m.media, m.media_seconds, m.media_path, COALESCE(t.text, '')
FROM messages m LEFT JOIN chats c ON c.jid = m.chat_jid
LEFT JOIN transcripts t ON t.chat_jid = m.chat_jid AND t.msg_id = m.id
WHERE m.media IN ('vocal', 'audio')
  AND (? = '' OR m.chat_jid = ?) AND (? = 0 OR m.ts >= ?) AND (? = 0 OR m.ts <= ?)
ORDER BY m.ts DESC LIMIT ?`, chatJID, chatJID, after, after, before, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []VoiceNote
	for rows.Next() {
		var v VoiceNote
		var path string
		if err := rows.Scan(&v.ID, &v.ChatJID, &v.ChatName, &v.Sender, &v.SenderName, &v.TS, &v.FromMe,
			&v.Text, &v.Media, &v.Seconds, &path, &v.Transcript); err != nil {
			return nil, err
		}
		v.At = fmtTS(v.TS)
		v.Downloaded = path != "" && !strings.HasPrefix(path, "error:")
		out = append(out, v)
	}
	return out, rows.Err()
}

// ---- file de téléchargement ----

type mediaJob struct {
	chat, id string
	seconds  int
	audio    *waE2E.AudioMessage
}

func (b *Bridge) enqueueVoice(ctx context.Context, chat, id string, am *waE2E.AudioMessage) {
	if !b.cfg.DownloadVoice || am == nil {
		return
	}
	if p, err := b.store.MediaPath(ctx, chat, id); err == nil && p != "" {
		return // déjà téléchargé (ou en erreur définitive)
	}
	select {
	case b.mediaQueue <- mediaJob{chat: chat, id: id, seconds: int(am.GetSeconds()), audio: am}:
	default:
		b.log.Warn("file de téléchargement pleine, vocal ignoré")
	}
}

func (b *Bridge) mediaWorker(ctx context.Context) {
	var ok, failed int
	tick := time.NewTicker(5 * time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if ok+failed > 0 {
				b.log.Info("vocaux téléchargés", "ok", ok, "échecs", failed, "en_attente", len(b.mediaQueue))
				ok, failed = 0, 0
			}
		case j := <-b.mediaQueue:
			data, err := b.client.Download(ctx, j.audio)
			if err != nil {
				// Média expiré côté serveur (historique ancien) ou clé invalide :
				// on note l'échec pour ne pas réessayer à chaque passage.
				_ = b.store.SetMedia(ctx, j.chat, j.id, "error:"+short(err.Error(), 60), j.seconds)
				failed++
				continue
			}
			user := j.chat
			if i := strings.IndexByte(user, '@'); i > 0 {
				user = user[:i]
			}
			dir := filepath.Join(b.cfg.MediaDir, "voice", user)
			if err := os.MkdirAll(dir, 0o700); err != nil {
				failed++
				continue
			}
			path := filepath.Join(dir, safeName(j.id)+extFor(j.audio.GetMimetype()))
			if err := os.WriteFile(path, data, 0o600); err != nil {
				failed++
				continue
			}
			_ = b.store.SetMedia(ctx, j.chat, j.id, path, j.seconds)
			ok++
			time.Sleep(300 * time.Millisecond) // cadence douce
		}
	}
}

func extFor(mime string) string {
	switch {
	case strings.Contains(mime, "ogg"), strings.Contains(mime, "opus"):
		return ".ogg"
	case strings.Contains(mime, "mp4"), strings.Contains(mime, "m4a"), strings.Contains(mime, "aac"):
		return ".m4a"
	case strings.Contains(mime, "mpeg"):
		return ".mp3"
	}
	return ".bin"
}

func safeName(s string) string {
	return strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			return r
		}
		return '_'
	}, s)
}

func short(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
