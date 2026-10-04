#!/usr/bin/env bash
# Usage: ./run.sh   (loads secrets without printing them, starts the server on :8000)
set -euo pipefail
cd "$(dirname "$0")"
set -a; source "${LEXORA_ENV:-$HOME/.config/hacklaw/lexora.env}"; set +a
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
