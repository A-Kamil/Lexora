import sqlite3
import time

import transcribe

SCHEMA = """
CREATE TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT DEFAULT '', ts INTEGER,
  from_me INTEGER DEFAULT 0, text TEXT DEFAULT '', media TEXT DEFAULT '', media_path TEXT DEFAULT '',
  media_seconds INTEGER DEFAULT 0, PRIMARY KEY (chat_jid, id));
CREATE TABLE transcripts (chat_jid TEXT, msg_id TEXT, text TEXT, language TEXT, model TEXT,
  duration_s REAL, created_at INTEGER, PRIMARY KEY (chat_jid, msg_id));
"""


class FakeTr:
    def __init__(self):
        self.calls = 0

    def transcribe(self, path):
        self.calls += 1
        if path.endswith("bad.ogg"):
            raise RuntimeError("corrompu")
        return "salut, on se voit demain", "fr", 4.2


def test_run_once_writes_transcript_and_message(tmp_path):
    conn = sqlite3.connect(":memory:")
    conn.executescript(SCHEMA)
    ok = tmp_path / "ok.ogg"; ok.write_bytes(b"x")
    bad = tmp_path / "bad.ogg"; bad.write_bytes(b"x")
    rows = [("A", "c@s", str(ok), 4), ("B", "c@s", str(bad), 5), ("C", "c@s", str(tmp_path / "absent.ogg"), 3),
            ("D", "c@s", "", 3), ("E", "c@s", str(ok), 9999)]
    for mid, chat, path, sec in rows:
        conn.execute("INSERT INTO messages(id, chat_jid, sender, ts, media, media_path, media_seconds) "
                     "VALUES (?, ?, 's', ?, 'vocal', ?, ?)", (mid, chat, int(time.time()), path, sec))
    tr = FakeTr()
    done, failed = transcribe.run_once(conn, tr)
    assert (done, failed) == (1, 2)          # A ok ; B illisible ; C absent ; D pas téléchargé ; E trop long
    assert tr.calls == 2
    assert conn.execute("SELECT text FROM messages WHERE id='A'").fetchone()[0] == "[vocal] salut, on se voit demain"
    assert conn.execute("SELECT language, duration_s FROM transcripts WHERE msg_id='A'").fetchone() == ("fr", 4.2)
    # 2e passe : rien à refaire (idempotent, les échecs sont marqués)
    assert transcribe.run_once(conn, FakeTr()) == (0, 0)
