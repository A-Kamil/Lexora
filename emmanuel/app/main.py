"""Lexora: WhatsApp legal intake -> case file for the lawyer.

Routes:
  POST /whatsapp            Twilio webhook (sandbox)
  GET  /simu, POST /simu    offline simulator of the WhatsApp conversation (demo backup)
  GET  /avocat              lawyer dashboard: list of cases
  GET  /avocat/{id}         lawyer dashboard: one case file (sources, agent journal)
  GET/POST /depot/{token}   document upload page sent to the client (large files, from a computer)
  GET  /api/cases[/{id}]    JSON for a separate front-end
"""
import json
import os
import time
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, File, Form, Request, UploadFile
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from . import intake, store, whatsapp

app = FastAPI(title="Lexora")
templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))
templates.env.filters["fromjson"] = lambda s: json.loads(s)
templates.env.filters["ts"] = lambda t: time.strftime("%d/%m %H:%M", time.localtime(t))
PUBLIC_URL = os.environ.get("LEXORA_PUBLIC_URL", "")  # e.g. https://xxxx.ngrok-free.app
SIMU_PHONE = "simu:+33600000000"
EXT = {"audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "application/pdf": "pdf",
       "image/jpeg": "jpg", "image/png": "png",
       "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx"}
MAX_UPLOAD = 20 * 1024 * 1024


@app.on_event("startup")
def _startup():
    store.init()


# ---------- Twilio ----------
@app.post("/whatsapp")
async def twilio_webhook(request: Request, background: BackgroundTasks):
    form = dict(await request.form())
    url = (PUBLIC_URL.rstrip("/") + "/whatsapp") if PUBLIC_URL else str(request.url)
    if not whatsapp.valid_signature(url, form, request.headers.get("X-Twilio-Signature", "")):
        return PlainTextResponse("bad signature", status_code=403)
    phone = form.get("From", "")
    if not whatsapp.allowed(phone):
        return PlainTextResponse("", status_code=204)  # dropped before storage
    media = []
    for i in range(int(form.get("NumMedia", 0) or 0)):
        media.append((form[f"MediaUrl{i}"], form.get(f"MediaContentType{i}", "application/octet-stream")))
    # Answer Twilio immediately (15 s timeout); process in the background.
    background.add_task(_process_twilio, phone, form.get("Body", ""), media)
    return PlainTextResponse("", status_code=200)


def _process_twilio(phone, body, media_urls):
    media = []
    for i, (url, ctype) in enumerate(media_urls):
        ext = EXT.get(ctype, "bin")
        media.append((whatsapp.download(url), ctype, f"piece-{i}.{ext}"))
    try:
        intake.handle(phone, body, media, whatsapp.send)
    except Exception as e:  # never leave the client without an answer
        whatsapp.send(phone, "Désolé, une erreur technique est survenue. Pouvez-vous renvoyer votre message ?")
        print("intake error:", type(e).__name__, e)


# ---------- offline simulator ----------
@app.get("/simu", response_class=HTMLResponse)
def simu_page(request: Request):
    case_id = store.open_case(SIMU_PHONE)
    return templates.TemplateResponse(request, "simu.html", {"messages": store.messages(case_id)})


@app.post("/simu")
async def simu_post(text: str = Form(""), file: UploadFile | None = File(None)):
    media = []
    if file is not None and file.filename:
        media.append((await file.read(), file.content_type or "application/octet-stream", file.filename))
    intake.handle(SIMU_PHONE, text, media, lambda to, body: None)
    return RedirectResponse("/simu", status_code=303)


@app.post("/simu/reset")
def simu_reset():
    store.new_case(SIMU_PHONE)
    return RedirectResponse("/simu", status_code=303)


# ---------- document upload link (sent to the client) ----------
@app.get("/depot/{token}", response_class=HTMLResponse)
def depot_page(request: Request, token: str):
    c = store.case_by_token(token)
    return templates.TemplateResponse(request, "depot.html", {"ok": bool(c), "done": request.query_params.get("ok"),
                                                              "token": token})


@app.post("/depot/{token}")
async def depot_post(token: str, files: list[UploadFile] = File(...)):
    c = store.case_by_token(token)
    if not c:
        return PlainTextResponse("lien expiré", status_code=404)
    for f in files:
        data = await f.read()
        if not f.filename or len(data) > MAX_UPLOAD:
            continue
        intake.add_media(c["id"], data, f.content_type or "application/octet-stream", f.filename)
    return RedirectResponse(f"/depot/{token}?ok=1", status_code=303)


# ---------- JSON API ----------
@app.get("/api/cases")
def api_cases():
    out = []
    for c in store.cases():
        f = json.loads(c["summary_json"]) if c.get("summary_json") else {}
        out.append({"id": c["id"], "status": c["status"], "updated_at": c["updated_at"],
                    "client": f.get("client") or c.get("client_name"), "employeur": f.get("employeur"),
                    "urgence": (f.get("urgence") or {}).get("niveau"),
                    "action": (f.get("urgence") or {}).get("action")})
    return out


@app.get("/api/cases/{case_id}")
def api_case(case_id: int):
    c = intake.case_view(case_id)
    if c:
        c.pop("upload_token", None)
        for d in c.get("documents", []):
            d.pop("path", None)
    return c


# ---------- lawyer dashboard ----------
@app.get("/", include_in_schema=False)
def root():
    return RedirectResponse("/avocat")


@app.get("/avocat", response_class=HTMLResponse)
def lawyer_list(request: Request):
    return templates.TemplateResponse(request, "cases.html", {"cases": store.cases()})


@app.get("/avocat/{case_id}/recap.md", response_class=PlainTextResponse)
def lawyer_recap(case_id: int):
    return PlainTextResponse(intake.recap_markdown(case_id), media_type="text/markdown; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="dossier-{case_id}.md"'})


@app.get("/avocat/{case_id}", response_class=HTMLResponse)
def lawyer_case(request: Request, case_id: int):
    return templates.TemplateResponse(request, "case.html", {"c": intake.case_view(case_id)})
