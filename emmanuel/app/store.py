"""SQLite storage: one case per client phone number."""
import json
import os
import sqlite3
import time
from contextlib import contextmanager

DB_PATH = os.environ.get("LEXORA_DB", "data/lexora.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',      -- open | sent_to_lawyer
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  summary_json TEXT,                         -- final case file for the lawyer
  client_name TEXT,
  upload_token TEXT
);
CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  entry_json TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                        -- article | decision | entreprise
  ref TEXT, title TEXT, url TEXT, extrait TEXT,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  direction TEXT NOT NULL,                   -- in | out
  kind TEXT NOT NULL,                        -- text | voice | document
  text TEXT,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL,
  filename TEXT,
  content_type TEXT,
  path TEXT,
  category TEXT,
  summary TEXT,
  ocr_text TEXT,
  created_at REAL NOT NULL
);
"""


@contextmanager
def db():
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    try:
        yield con
        con.commit()
    finally:
        con.close()


def init():
    with db() as con:
        con.executescript(SCHEMA)
        cols = {r["name"] for r in con.execute("PRAGMA table_info(cases)")}
        for col in ("client_name", "upload_token"):
            if col not in cols:  # databases created by the first version
                con.execute(f"ALTER TABLE cases ADD COLUMN {col} TEXT")


SESSION_HOURS = float(os.environ.get("LEXORA_SESSION_HOURS", "12"))


def open_case(phone: str) -> int:
    """Return the open case for this phone, or create one. An idle case expires after SESSION_HOURS."""
    with db() as con:
        row = con.execute(
            "SELECT id, updated_at FROM cases WHERE phone=? AND status='open' ORDER BY id DESC LIMIT 1", (phone,)
        ).fetchone()
        if row and time.time() - row["updated_at"] < SESSION_HOURS * 3600:
            return row["id"]
        if row:
            con.execute("UPDATE cases SET status='expired' WHERE id=?", (row["id"],))
    return new_case(phone)


def new_case(phone: str) -> int:
    import secrets
    now = time.time()
    with db() as con:
        con.execute("UPDATE cases SET status='abandoned' WHERE phone=? AND status='open'", (phone,))
        cur = con.execute(
            "INSERT INTO cases(phone,status,created_at,updated_at,upload_token) VALUES(?,?,?,?,?)",
            (phone, "open", now, now, secrets.token_urlsafe(16)),
        )
        return cur.lastrowid


def case_by_token(token: str):
    with db() as con:
        r = con.execute("SELECT * FROM cases WHERE upload_token=? AND status='open'", (token,)).fetchone()
        return dict(r) if r else None


def set_client_name(case_id: int, name: str):
    with db() as con:
        con.execute("UPDATE cases SET client_name=? WHERE id=?", (name, case_id))


def add_journal(case_id: int, entry: dict, h: str):
    with db() as con:
        con.execute("INSERT INTO journal(case_id,entry_json,hash) VALUES(?,?,?)",
                    (case_id, json.dumps(entry, sort_keys=True, ensure_ascii=False), h))


def last_journal_hash(case_id: int):
    with db() as con:
        r = con.execute("SELECT hash FROM journal WHERE case_id=? ORDER BY id DESC LIMIT 1", (case_id,)).fetchone()
        return r["hash"] if r else None


def journal(case_id: int):
    with db() as con:
        return [dict(r) for r in con.execute("SELECT * FROM journal WHERE case_id=? ORDER BY id", (case_id,))]


def add_source(case_id: int, kind: str, ref, title, url, extrait):
    with db() as con:
        dup = con.execute("SELECT 1 FROM sources WHERE case_id=? AND ref=?", (case_id, ref)).fetchone()
        if not dup:
            con.execute("INSERT INTO sources(case_id,kind,ref,title,url,extrait,created_at) VALUES(?,?,?,?,?,?,?)",
                        (case_id, kind, ref, title, url, extrait, time.time()))


def sources(case_id: int):
    with db() as con:
        return [dict(r) for r in con.execute("SELECT * FROM sources WHERE case_id=? ORDER BY id", (case_id,))]


def add_message(case_id: int, direction: str, kind: str, text: str):
    with db() as con:
        now = time.time()
        con.execute(
            "INSERT INTO messages(case_id,direction,kind,text,created_at) VALUES(?,?,?,?,?)",
            (case_id, direction, kind, text, now),
        )
        con.execute("UPDATE cases SET updated_at=? WHERE id=?", (now, case_id))


def add_document(case_id: int, filename, content_type, path, category, summary, ocr_text):
    with db() as con:
        con.execute(
            "INSERT INTO documents(case_id,filename,content_type,path,category,summary,ocr_text,created_at)"
            " VALUES(?,?,?,?,?,?,?,?)",
            (case_id, filename, content_type, path, category, summary, ocr_text, time.time()),
        )


def messages(case_id: int):
    with db() as con:
        return [dict(r) for r in con.execute("SELECT * FROM messages WHERE case_id=? ORDER BY id", (case_id,))]


def documents(case_id: int):
    with db() as con:
        return [dict(r) for r in con.execute("SELECT * FROM documents WHERE case_id=? ORDER BY id", (case_id,))]


def close_case(case_id: int, summary: dict):
    with db() as con:
        con.execute(
            "UPDATE cases SET status='sent_to_lawyer', summary_json=?, updated_at=? WHERE id=?",
            (json.dumps(summary, ensure_ascii=False), time.time(), case_id),
        )


def cases():
    with db() as con:
        return [dict(r) for r in con.execute("SELECT * FROM cases ORDER BY updated_at DESC")]


def case(case_id: int):
    with db() as con:
        r = con.execute("SELECT * FROM cases WHERE id=?", (case_id,)).fetchone()
        return dict(r) if r else None
