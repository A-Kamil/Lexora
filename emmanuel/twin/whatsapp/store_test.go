package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	s, err := openStore(context.Background(), filepath.Join(t.TempDir(), "messages.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestInsertIdempotentAndSearchAccents(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	m := Msg{ID: "A1", ChatJID: "33600000000@s.whatsapp.net", Sender: "33600000000@s.whatsapp.net",
		SenderName: "Test", TS: 1_700_000_000, Text: "Réunion demain à 9h pour le projet"}
	if err := s.UpsertChat(ctx, m.ChatJID, "Test", false, m.TS); err != nil {
		t.Fatal(err)
	}
	if ok, err := s.InsertMsg(ctx, m); err != nil || !ok {
		t.Fatalf("1re insertion : ok=%v err=%v", ok, err)
	}
	// L'historique et le flux live se recoupent : la 2e insertion doit être ignorée.
	if ok, err := s.InsertMsg(ctx, m); err != nil || ok {
		t.Fatalf("2e insertion devrait être ignorée : ok=%v err=%v", ok, err)
	}
	// remove_diacritics : « reunion » retrouve « Réunion » ; ET implicite entre mots.
	hits, err := s.Search(ctx, "reunion projet", "", 0, 0, 10)
	if err != nil || len(hits) != 1 {
		t.Fatalf("search accents : n=%d err=%v", len(hits), err)
	}
	if hits[0].ChatName != "Test" || hits[0].At == "" {
		t.Fatalf("jointure chat/format date : %+v", hits[0])
	}
	if hits, _ := s.Search(ctx, "reunion absent", "", 0, 0, 10); len(hits) != 0 {
		t.Fatalf("ET implicite cassé : %d résultats", len(hits))
	}
	// Une requête avec syntaxe FTS5 ne doit ni planter ni injecter d'opérateur.
	if _, err := s.Search(ctx, `"projet" OR NOT (x*`, "", 0, 0, 10); err != nil {
		t.Fatalf("requête hostile : %v", err)
	}
}

func TestUpsertChatKeepsNameAndMaxTS(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	jid := "120363000000000000@g.us"
	must(t, s.UpsertChat(ctx, jid, "Famille", true, 200))
	must(t, s.UpsertChat(ctx, jid, "", true, 100)) // nom vide + ts plus ancien
	chats, err := s.ListChats(ctx, "", 10)
	if err != nil || len(chats) != 1 {
		t.Fatal(err, chats)
	}
	if chats[0].Name != "Famille" || chats[0].LastTS != 200 || !chats[0].IsGroup {
		t.Fatalf("upsert a écrasé : %+v", chats[0])
	}
}

func TestParseDate(t *testing.T) {
	a, err := parseDate("2026-09-05", false)
	b, err2 := parseDate("2026-09-05", true)
	if err != nil || err2 != nil || b-a != 86399 {
		t.Fatalf("plafond fin de journée : %d %d %v %v", a, b, err, err2)
	}
	if _, err := parseDate("hier", false); err == nil {
		t.Fatal("date invalide acceptée")
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestRedactWhatsmeowLogs(t *testing.T) {
	in := `Node handling took 1m for <message from="status@broadcast" notify="Prénom NOM " participant_pn="33612345678@s.whatsapp.net">`
	out := redact(in)
	if strings.Contains(out, "Prénom") || strings.Contains(out, "33612345678") {
		t.Fatalf("fuite dans les logs : %s", out)
	}
	if !strings.Contains(out, `notify="…"`) || !strings.Contains(out, "<num>@s.whatsapp.net") {
		t.Fatalf("caviardage inattendu : %s", out)
	}
}

func TestCallsLiveLifecycleAndStats(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	// Offre → acceptation → fin : durée = fin - acceptation, issue connected.
	must(t, s.UpsertCall(ctx, Call{ID: "c1", ChatJID: "336@s.whatsapp.net", Peer: "336@s.whatsapp.net",
		Direction: "in", Media: "voice", Outcome: "unknown", StartedTS: 1000, Source: "live"}))
	must(t, s.callAnswered(ctx, "c1", 1010))
	must(t, s.callEnded(ctx, "c1", 1130, "missed"))
	// Offre → fin sans réponse : manqué, durée 0.
	must(t, s.UpsertCall(ctx, Call{ID: "c2", ChatJID: "337@s.whatsapp.net", Peer: "337@s.whatsapp.net",
		Direction: "in", Media: "video", Outcome: "unknown", StartedTS: 2000, Source: "live"}))
	must(t, s.callEnded(ctx, "c2", 2030, "missed"))
	// Historique : idempotent.
	h := Call{ID: "h1", ChatJID: "336@s.whatsapp.net", Peer: "336@s.whatsapp.net", Direction: "out",
		Media: "voice", Outcome: "connected", StartedTS: 3000, Duration: 300, Source: "history"}
	must(t, s.UpsertCall(ctx, h))
	must(t, s.UpsertCall(ctx, h))

	calls, err := s.ListCalls(ctx, "", 0, 0, 10)
	must(t, err)
	if len(calls) != 3 || calls[0].ID != "h1" {
		t.Fatalf("liste : %+v", calls)
	}
	byID := map[string]Call{}
	for _, c := range calls {
		byID[c.ID] = c
	}
	if byID["c1"].Outcome != "connected" || byID["c1"].Duration != 120 {
		t.Fatalf("c1 : %+v", byID["c1"])
	}
	if byID["c2"].Outcome != "missed" || byID["c2"].Duration != 0 {
		t.Fatalf("c2 : %+v", byID["c2"])
	}
	st, err := s.CallStats(ctx, 0, 0, 5)
	must(t, err)
	if st.Total != 3 || st.ByOutcome["connected"] != 2 || st.ByMedia["video"] != 1 ||
		st.TotalMinutes != 7 || st.AvgMinutes != 3.5 || len(st.TopPeers) != 2 || st.TopPeers[0].Calls != 2 {
		t.Fatalf("stats : %+v", st)
	}
	only, _ := s.ListCalls(ctx, "337@s.whatsapp.net", 0, 0, 10)
	if len(only) != 1 {
		t.Fatalf("filtre peer : %d", len(only))
	}
}

func TestTranscriptUpdateIsSearchable(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	m := Msg{ID: "V1", ChatJID: "336@s.whatsapp.net", Sender: "336@s.whatsapp.net", TS: 1, Media: "vocal"}
	must(t, s.UpsertChat(ctx, m.ChatJID, "Test", false, 1))
	if ok, err := s.InsertMsg(ctx, m); err != nil || !ok {
		t.Fatal(err)
	}
	must(t, s.SetMedia(ctx, m.ChatJID, m.ID, "/tmp/x.ogg", 12))
	// Le worker Python fait exactement ceci : insérer la transcription puis
	// remplacer le texte du message.
	if _, err := s.db.ExecContext(ctx, `INSERT INTO transcripts(chat_jid, msg_id, text, language, model, duration_s, created_at)
VALUES (?, ?, ?, 'fr', 'small', 12, 1)`, m.ChatJID, m.ID, "on se retrouve à la réunion demain"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE messages SET text = ? WHERE chat_jid = ? AND id = ?`,
		"[vocal] on se retrouve à la réunion demain", m.ChatJID, m.ID); err != nil {
		t.Fatal(err)
	}
	hits, err := s.Search(ctx, "reunion", "", 0, 0, 5)
	if err != nil || len(hits) != 1 || hits[0].Media != "vocal" {
		t.Fatalf("transcription non indexée : n=%d err=%v", len(hits), err)
	}
	notes, err := s.VoiceNotes(ctx, "", 0, 0, 10)
	if err != nil || len(notes) != 1 || !notes[0].Downloaded || notes[0].Seconds != 12 || notes[0].Transcript == "" {
		t.Fatalf("voice_notes : %+v err=%v", notes, err)
	}
}
