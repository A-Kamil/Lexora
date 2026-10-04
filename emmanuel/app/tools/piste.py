"""OAuth client for PISTE (Légifrance, Judilibre). Token cached until expiry."""
import os
import time

import httpx

ENV = os.environ.get("PISTE_ENV", "prod")  # prod | sandbox
OAUTH = {"prod": "https://oauth.piste.gouv.fr/api/oauth/token",
         "sandbox": "https://sandbox-oauth.piste.gouv.fr/api/oauth/token"}[ENV]
API = {"prod": "https://api.piste.gouv.fr", "sandbox": "https://sandbox-api.piste.gouv.fr"}[ENV]

_token = {"value": None, "exp": 0.0}


def configured() -> bool:
    return bool(os.environ.get("PISTE_CLIENT_ID") and os.environ.get("PISTE_CLIENT_SECRET"))


def token() -> str:
    if _token["value"] and time.time() < _token["exp"] - 60:
        return _token["value"]
    r = httpx.post(OAUTH, data={
        "grant_type": "client_credentials",
        "client_id": os.environ["PISTE_CLIENT_ID"],
        "client_secret": os.environ["PISTE_CLIENT_SECRET"],
        "scope": "openid",
    }, timeout=20)
    r.raise_for_status()
    j = r.json()
    _token.update(value=j["access_token"], exp=time.time() + int(j.get("expires_in", 3600)))
    return _token["value"]


def post(path: str, body: dict) -> dict:
    r = httpx.post(API + path, json=body, timeout=30,
                   headers={"Authorization": f"Bearer {token()}", "Accept": "application/json"})
    r.raise_for_status()
    return r.json()


def get(path: str, params: dict) -> dict:
    r = httpx.get(API + path, params=params, timeout=30,
                  headers={"Authorization": f"Bearer {token()}", "Accept": "application/json"})
    r.raise_for_status()
    return r.json()
