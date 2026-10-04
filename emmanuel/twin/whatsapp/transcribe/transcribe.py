#!/usr/bin/env python3
"""Transcription des notes vocales WhatsApp : Voxtral (Mistral, défaut) ou faster-whisper (local, hors ligne).

Lit messages.db (rempli par twin-whatsapp), transcrit chaque vocal téléchargé
qui n'a pas encore de transcription, puis :
  1. insère une ligne dans `transcripts` (chat_jid, msg_id, texte, langue,
     modèle, durée) — la clé (chat, message) rejoint messages → expéditeur,
     heure, conversation ;
  2. remplace le texte du message par « [vocal] … » : le trigger FTS le rend
     cherchable, et tous les outils MCP (search_messages, get_messages,
     voice_notes) le voient sans code spécial.

    .venv/bin/python transcribe.py            # une passe
    .venv/bin/python transcribe.py --watch    # boucle (TWIN_WHISPER_INTERVAL s)

Config (environnement) :
  TWIN_WA_DB             ../data/messages.db
  TWIN_STT               voxtral      (voxtral = API Mistral, MISTRAL_API_KEY ; whisper = local)
  TWIN_VOXTRAL_MODEL     voxtral-mini-latest
  TWIN_WHISPER_MODEL     small        (tiny/base/small/medium/large-v3 ; small = bon FR/CPU)
  TWIN_WHISPER_DEVICE    cpu          (cuda : voir CLAUDE.md « Optimisation CUDA »)
  TWIN_WHISPER_COMPUTE   int8
  TWIN_WHISPER_LANG      fr           (vide = détection automatique)
  TWIN_WHISPER_INTERVAL  60
  TWIN_WHISPER_MAX_S     600          (ignorer les audios plus longs)
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
DB = Path(os.environ.get("TWIN_WA_DB", str(HERE.parent / "data" / "messages.db")))
STT = os.environ.get("TWIN_STT", "voxtral")
MODEL = os.environ.get("TWIN_VOXTRAL_MODEL", "voxtral-mini-latest") if STT == "voxtral" else os.environ.get("TWIN_WHISPER_MODEL", "small")
DEVICE = os.environ.get("TWIN_WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("TWIN_WHISPER_COMPUTE", "int8")
LANG = os.environ.get("TWIN_WHISPER_LANG", "fr") or None
INTERVAL = int(os.environ.get("TWIN_WHISPER_INTERVAL", "60"))
MAX_S = int(os.environ.get("TWIN_WHISPER_MAX_S", "600"))

PENDING_SQL = """
SELECT m.chat_jid, m.id, m.media_path, m.media_seconds
FROM messages m LEFT JOIN transcripts t ON t.chat_jid = m.chat_jid AND t.msg_id = m.id
WHERE m.media IN ('vocal', 'audio') AND m.media_path <> '' AND m.media_path NOT LIKE 'error:%'
  AND t.msg_id IS NULL AND m.media_seconds <= ?
ORDER BY m.ts DESC LIMIT ?"""


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, file=sys.stderr, flush=True)


class Transcriber:
    def __init__(self):
        self._model = None

    def model(self):
        if self._model is None:
            from faster_whisper import WhisperModel
            log(f"chargement whisper {MODEL} ({DEVICE}/{COMPUTE})…")
            self._model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE)
        return self._model

    def transcribe(self, path: str) -> tuple[str, str, float]:
        """(texte, langue, durée s)."""
        if STT == "voxtral":
            return self._voxtral(path)
        # vad_filter coupe les silences de début/fin.
        segments, info = self.model().transcribe(path, language=LANG, vad_filter=True, beam_size=5)
        text = " ".join(s.text.strip() for s in segments).strip()
        return text, info.language, float(info.duration or 0)


    def _voxtral(self, path: str) -> tuple[str, str, float]:
        if self._model is None:
            from mistralai import Mistral
            self._model = Mistral(api_key=os.environ["MISTRAL_API_KEY"])
        with open(path, "rb") as f:
            res = self._model.audio.transcriptions.complete(
                model=MODEL, file={"content": f.read(), "file_name": Path(path).name}, language=LANG)
        return res.text.strip(), getattr(res, "language", None) or (LANG or ""), 0.0


def run_once(conn: sqlite3.Connection, tr: Transcriber, limit: int = 200) -> tuple[int, int]:
    done = failed = 0
    for chat, mid, path, seconds in conn.execute(PENDING_SQL, (MAX_S, limit)).fetchall():
        if not Path(path).exists():
            conn.execute("UPDATE messages SET media_path = 'error:fichier absent' WHERE chat_jid = ? AND id = ?",
                         (chat, mid))
            conn.commit()
            failed += 1
            continue
        t0 = time.monotonic()
        try:
            text, lang, dur = tr.transcribe(path)
        except Exception as e:  # audio illisible : on marque pour ne pas boucler
            conn.execute("INSERT OR IGNORE INTO transcripts(chat_jid, msg_id, text, language, model, duration_s, created_at) "
                         "VALUES (?, ?, '', '', ?, 0, ?)", (chat, mid, f"{MODEL}:error:{type(e).__name__}", int(time.time())))
            conn.commit()
            failed += 1
            continue
        conn.execute("INSERT OR REPLACE INTO transcripts(chat_jid, msg_id, text, language, model, duration_s, created_at) "
                     "VALUES (?, ?, ?, ?, ?, ?, ?)", (chat, mid, text, lang, MODEL, dur, int(time.time())))
        if text:
            conn.execute("UPDATE messages SET text = ? WHERE chat_jid = ? AND id = ?", ("[vocal] " + text, chat, mid))
        conn.commit()
        done += 1
        # jamais le texte dans les logs (T1)
        log(f"transcrit {mid[:8]}… {dur:.0f}s audio en {time.monotonic()-t0:.1f}s, {len(text)} car., {lang}")
    return done, failed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--watch", action="store_true", help="boucler toutes les TWIN_WHISPER_INTERVAL s")
    ap.add_argument("--limit", type=int, default=200)
    args = ap.parse_args()
    if not DB.exists():
        log(f"base introuvable : {DB}")
        return 1
    conn = sqlite3.connect(str(DB), timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    tr = Transcriber()
    while True:
        done, failed = run_once(conn, tr, args.limit)
        if done or failed:
            log(f"passe terminée : {done} transcrits, {failed} échecs")
        if not args.watch:
            return 0
        time.sleep(INTERVAL)


if __name__ == "__main__":
    sys.exit(main())
