package main

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	_ "modernc.org/sqlite" // pilote pur Go : pas de CGO, binaire portable
)

// Store est le miroir local des messages (messages.db). Distinct de la base de
// session whatsmeow (session.db) pour pouvoir le purger ou le ré-indexer sans
// perdre l'appairage.
type Store struct{ db *sql.DB }

const schema = `
CREATE TABLE IF NOT EXISTS chats (
  jid      TEXT PRIMARY KEY,
  name     TEXT NOT NULL DEFAULT '',
  is_group INTEGER NOT NULL DEFAULT 0,
  last_ts  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT NOT NULL,
  chat_jid    TEXT NOT NULL,
  sender      TEXT NOT NULL,
  sender_name TEXT NOT NULL DEFAULT '',
  ts          INTEGER NOT NULL,
  from_me     INTEGER NOT NULL DEFAULT 0,
  text        TEXT NOT NULL DEFAULT '',
  media       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (chat_jid, id)
);
CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages(chat_jid, ts DESC);
CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts DESC);
-- Index plein texte externe (content=) : le texte n'est stocké qu'une fois.
-- remove_diacritics 2 : « reunion » retrouve « réunion ».
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, content='messages', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
`

func sqliteDSN(path string) string {
	return "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"
}

func openStore(ctx context.Context, path string) (*Store, error) {
	db, err := sql.Open("sqlite", sqliteDSN(path))
	if err != nil {
		return nil, err
	}
	// Une seule connexion : SQLite sérialise les écritures de toute façon, et
	// ça évite les SQLITE_BUSY entre le flux d'événements et les outils MCP.
	db.SetMaxOpenConns(1)
	if _, err := db.ExecContext(ctx, schema+callsSchema); err != nil {
		db.Close()
		return nil, fmt.Errorf("schéma messages.db : %w", err)
	}
	// Statuts (stories) et chaînes ne sont pas des conversations ; on purge
	// ce qu'une version antérieure aurait pu stocker.
	if _, err := db.ExecContext(ctx, `
DELETE FROM messages WHERE chat_jid LIKE '%@broadcast' OR chat_jid LIKE '%@newsletter';
DELETE FROM chats    WHERE jid      LIKE '%@broadcast' OR jid      LIKE '%@newsletter';`); err != nil {
		db.Close()
		return nil, err
	}
	st := &Store{db: db}
	if err := st.migrate(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("migration messages.db : %w", err)
	}
	return st, nil
}

// --- rattrapage des noms : les push names arrivent APRÈS les premiers blocs
// d'historique, donc une partie des chats/expéditeurs est stockée sans nom.

func (s *Store) ChatsWithoutName(ctx context.Context) ([]string, error) {
	return s.column(ctx, `SELECT jid FROM chats WHERE name = ''`)
}

func (s *Store) SendersWithoutName(ctx context.Context) ([]string, error) {
	return s.column(ctx, `SELECT DISTINCT sender FROM messages WHERE sender_name = '' AND from_me = 0`)
}

func (s *Store) SetChatName(ctx context.Context, jid, name string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE chats SET name = ? WHERE jid = ? AND name = ''`, name, jid)
	return err
}

func (s *Store) SetSenderName(ctx context.Context, sender, name string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE messages SET sender_name = ? WHERE sender = ? AND sender_name = ''`, name, sender)
	return err
}

func (s *Store) column(ctx context.Context, q string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Store) Close() error { return s.db.Close() }

type Chat struct {
	JID     string `json:"jid"`
	Name    string `json:"name"`
	IsGroup bool   `json:"is_group"`
	LastTS  int64  `json:"-"`
	Last    string `json:"last_message_at"`
}

type Msg struct {
	ID         string `json:"id"`
	ChatJID    string `json:"chat_jid"`
	ChatName   string `json:"chat_name,omitempty"`
	Sender     string `json:"sender"`
	SenderName string `json:"sender_name,omitempty"`
	TS         int64  `json:"-"`
	At         string `json:"at"`
	FromMe     bool   `json:"from_me"`
	Text       string `json:"text"`
	Media      string `json:"media,omitempty"`
}

// UpsertChat ne remplace jamais un nom connu par un nom vide, et ne fait
// jamais reculer last_ts (l'historique arrive dans le désordre).
func (s *Store) UpsertChat(ctx context.Context, jid, name string, isGroup bool, ts int64) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO chats(jid, name, is_group, last_ts) VALUES (?, ?, ?, ?)
ON CONFLICT(jid) DO UPDATE SET
  name     = CASE WHEN excluded.name <> '' THEN excluded.name ELSE chats.name END,
  is_group = excluded.is_group,
  last_ts  = MAX(chats.last_ts, excluded.last_ts)`, jid, name, isGroup, ts)
	return err
}

// InsertMsg est idempotent : l'historique et le flux live se recoupent.
func (s *Store) InsertMsg(ctx context.Context, m Msg) (bool, error) {
	res, err := s.db.ExecContext(ctx, `
INSERT OR IGNORE INTO messages(id, chat_jid, sender, sender_name, ts, from_me, text, media)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		m.ID, m.ChatJID, m.Sender, m.SenderName, m.TS, m.FromMe, m.Text, m.Media)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *Store) ListChats(ctx context.Context, query string, limit int) ([]Chat, error) {
	// Un chat sans nom connu est présenté par son numéro (+336…), sinon le
	// modèle n'a aucun moyen de le désigner.
	rows, err := s.db.QueryContext(ctx, `
SELECT jid,
       CASE WHEN name = '' AND jid LIKE '%@s.whatsapp.net'
            THEN '+' || substr(jid, 1, instr(jid, '@') - 1) ELSE name END,
       is_group, last_ts
FROM chats
WHERE ? = '' OR name LIKE '%' || ? || '%' OR jid LIKE '%' || ? || '%'
ORDER BY last_ts DESC LIMIT ?`, query, query, query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Chat
	for rows.Next() {
		var c Chat
		if err := rows.Scan(&c.JID, &c.Name, &c.IsGroup, &c.LastTS); err != nil {
			return nil, err
		}
		c.Last = fmtTS(c.LastTS)
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) Messages(ctx context.Context, chatJID string, before int64, limit int) ([]Msg, error) {
	return s.queryMsgs(ctx, `
SELECT m.id, m.chat_jid, c.name, m.sender, m.sender_name, m.ts, m.from_me, m.text, m.media
FROM messages m LEFT JOIN chats c ON c.jid = m.chat_jid
WHERE m.chat_jid = ? AND (? = 0 OR m.ts < ?)
ORDER BY m.ts DESC LIMIT ?`, chatJID, before, before, limit)
}

func (s *Store) Search(ctx context.Context, query, chatJID string, after, before int64, limit int) ([]Msg, error) {
	return s.queryMsgs(ctx, `
SELECT m.id, m.chat_jid, c.name, m.sender, m.sender_name, m.ts, m.from_me, m.text, m.media
FROM messages_fts
JOIN messages m ON m.rowid = messages_fts.rowid
LEFT JOIN chats c ON c.jid = m.chat_jid
WHERE messages_fts MATCH ?
  AND (? = '' OR m.chat_jid = ?)
  AND (? = 0 OR m.ts >= ?)
  AND (? = 0 OR m.ts <= ?)
ORDER BY m.ts DESC LIMIT ?`, ftsQuery(query), chatJID, chatJID, after, after, before, before, limit)
}

func (s *Store) queryMsgs(ctx context.Context, q string, args ...any) ([]Msg, error) {
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Msg
	for rows.Next() {
		var m Msg
		var chatName sql.NullString
		if err := rows.Scan(&m.ID, &m.ChatJID, &chatName, &m.Sender, &m.SenderName,
			&m.TS, &m.FromMe, &m.Text, &m.Media); err != nil {
			return nil, err
		}
		m.ChatName = chatName.String
		m.At = fmtTS(m.TS)
		out = append(out, m)
	}
	return out, rows.Err()
}

type Stats struct {
	Chats    int    `json:"chats"`
	Messages int    `json:"messages"`
	Last     string `json:"last_message_at"`
}

func (s *Store) Stats(ctx context.Context) (Stats, error) {
	var st Stats
	var last int64
	err := s.db.QueryRowContext(ctx, `
SELECT (SELECT COUNT(*) FROM chats), (SELECT COUNT(*) FROM messages),
       (SELECT COALESCE(MAX(ts), 0) FROM messages)`).Scan(&st.Chats, &st.Messages, &last)
	st.Last = fmtTS(last)
	return st, err
}

// ftsQuery neutralise la syntaxe FTS5 : chaque mot devient un terme entre
// guillemets (ET implicite). Une requête libre ne peut donc ni casser le
// parseur ni injecter d'opérateur.
func ftsQuery(q string) string {
	words := strings.Fields(q)
	for i, w := range words {
		words[i] = `"` + strings.ReplaceAll(w, `"`, `""`) + `"`
	}
	return strings.Join(words, " ")
}
