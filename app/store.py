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
  summary_json TEXT                          -- final case file for the lawyer
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


def open_case(phone: str) -> int:
    """Return the open case for this phone, or create one."""
    with db() as con:
        row = con.execute(
            "SELECT id FROM cases WHERE phone=? AND status='open' ORDER BY id DESC LIMIT 1", (phone,)
        ).fetchone()
        if row:
            return row["id"]
        now = time.time()
        cur = con.execute(
            "INSERT INTO cases(phone,status,created_at,updated_at) VALUES(?,?,?,?)", (phone, "open", now, now)
        )
        return cur.lastrowid


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
