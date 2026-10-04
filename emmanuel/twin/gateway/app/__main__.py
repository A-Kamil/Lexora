"""python -m app  →  lance uvicorn sur TWIN_GW_LISTEN."""
import uvicorn

from .config import settings

if __name__ == "__main__":
    host, _, port = settings().listen.rpartition(":")
    uvicorn.run("app.main:app", host=host or "127.0.0.1", port=int(port), log_level="warning")
