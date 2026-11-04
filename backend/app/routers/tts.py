"""Read-aloud (TTS) endpoints backed by an OpenAI-compatible /v1/audio/speech API."""
from __future__ import annotations

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from ..config import load_config
from ..features import tts as tts_feat

router = APIRouter(prefix="/api/tts", tags=["tts"])

# content types for the response formats we allow
_MEDIA_TYPES = {
    "mp3": "audio/mpeg",
    "opus": "audio/ogg",
    "aac": "audio/aac",
    "flac": "audio/flac",
    "wav": "audio/wav",
}


class SpeakBody(BaseModel):
    text: str | None = None
    paper_id: str | None = None
    page: int | None = None


@router.post("/speak")
async def speak(body: SpeakBody):
    """Synthesize ad-hoc text, or one parsed PDF page, to audio bytes."""
    text = (body.text or "").strip()
    if not text:
        if not body.paper_id or body.page is None:
            raise HTTPException(400, "provide text, or paper_id + page")
        try:
            text = tts_feat.page_text(body.paper_id, body.page)
        except ValueError as e:
            raise HTTPException(400, str(e))
    try:
        audio = await tts_feat.synthesize(text)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except httpx.HTTPError as e:
        raise HTTPException(502, f"TTS request failed: {e}")
    fmt = tts_feat.tts_settings()["response_format"]
    return Response(
        content=audio,
        media_type=_MEDIA_TYPES.get(fmt, "audio/mpeg"),
        headers={"Cache-Control": "no-store"},
    )


@router.get("/config")
async def tts_config():
    """Public TTS status for the UI (secret masked; actual key never leaves)."""
    s = tts_feat.tts_settings()
    return {
        "configured": tts_feat.is_configured(),
        "model": s["model"],
        "voice": s["voice"],
        "response_format": s["response_format"],
        "speed": s["speed"],
        "language": load_config().get("output_language", ""),
    }


class TestBody(BaseModel):
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None


@router.post("/test")
async def test_tts(body: TestBody):
    """Check the gateway with a tiny 'Hello' request (unsaved credentials ok)."""
    base = (body.base_url or tts_feat.tts_settings()["base_url"]).strip().rstrip("/")
    key = body.api_key or tts_feat.tts_settings()["api_key"]
    model = (body.model or tts_feat.tts_settings()["model"]).strip()
    if not base or not key or not model:
        return {"ok": False, "error": "base_url, api_key and model are all required"}
    try:
        async with httpx.AsyncClient(timeout=20, trust_env=False) as client:
            r = await client.post(
                base + "/audio/speech",
                headers={"Authorization": f"Bearer {key}"},
                json={"model": model, "input": "Hello"},
            )
    except httpx.HTTPError as e:
        return {"ok": False, "error": f"connection failed: {e}"}
    if r.status_code != 200:
        return {"ok": False, "error": f"HTTP {r.status_code}: {r.text[:200]}"}
    if not r.content:
        return {"ok": False, "error": "endpoint returned an empty audio body"}
    return {"ok": True, "bytes": len(r.content)}
