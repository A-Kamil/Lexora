"""Lexora: WhatsApp legal intake -> case file for the lawyer.

Routes:
  POST /whatsapp            Twilio webhook (sandbox)
  GET  /simu, POST /simu    offline simulator of the WhatsApp conversation (demo backup)
  GET  /avocat              lawyer dashboard: list of cases
  GET  /avocat/{id}         lawyer dashboard: one case file
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
        ext = {"audio/ogg": "ogg", "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png"}.get(ctype, "bin")
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
    case_id = store.open_case(SIMU_PHONE)
    store.close_case(case_id, {"resume_faits": "(session de simulation réinitialisée)"})
    return RedirectResponse("/simu", status_code=303)


# ---------- lawyer dashboard ----------
@app.get("/", include_in_schema=False)
def root():
    return RedirectResponse("/avocat")


@app.get("/avocat", response_class=HTMLResponse)
def lawyer_list(request: Request):
    return templates.TemplateResponse(request, "cases.html", {"cases": store.cases()})


@app.get("/avocat/{case_id}", response_class=HTMLResponse)
def lawyer_case(request: Request, case_id: int):
    return templates.TemplateResponse(request, "case.html", {"c": intake.case_view(case_id)})
