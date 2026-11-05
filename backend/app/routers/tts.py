"""Read-aloud (TTS) endpoints backed by an OpenAI-compatible /v1/audio/speech API."""
from __future__ import annotations

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from ..config import load_config
from ..features import read_plan
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
    text: str


@router.post("/speak")
async def speak(body: SpeakBody):
    """Synthesize one piece of text (a paragraph or a selection chunk) to audio bytes."""
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "provide text")
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


@router.get("/plan/{paper_id}")
async def plan(paper_id: str):
    """The paper as ordered speakable paragraphs (with bboxes, sections, skip tags)."""
    try:
        return read_plan.paper_plan(paper_id)
    except ValueError as e:
        raise HTTPException(404, str(e))


class ChunksBody(BaseModel):
    text: str


@router.post("/chunks")
async def chunks(body: ChunksBody):
    """Split ad-hoc text into the pieces the UI synthesizes one by one (for progress)."""
    return {"chunks": tts_feat.chunk_text(tts_feat.clean_for_speech(body.text or ""))}


@router.get("/config")
async def tts_config():
    """Public TTS status for the UI (secret masked; actual key never leaves)."""
    s = tts_feat.tts_settings()
    return {
        "configured": tts_feat.is_configured(),
        "model": s["model"],
        "voice": s["voice"],
        "response_format": s["response_format"],
        "instructions": s["instructions"],
        "speed": s["speed"],
        "language": load_config().get("output_language", ""),
    }


class TestBody(BaseModel):
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None
    instructions: str | None = None


@router.post("/test")
async def test_tts(body: TestBody):
    """Check the gateway with a tiny 'Hello' request (unsaved credentials ok)."""
    base = (body.base_url or tts_feat.tts_settings()["base_url"]).strip().rstrip("/")
    key = body.api_key or tts_feat.tts_settings()["api_key"]
    model = (body.model or tts_feat.tts_settings()["model"]).strip()
    instructions = (
        body.instructions if body.instructions is not None else tts_feat.tts_settings()["instructions"]
    ).strip()
    if not base or not key or not model:
        return {"ok": False, "error": "base_url, api_key and model are all required"}
    payload = {"model": model, "input": "Hello"}
    if instructions:
        payload["instructions"] = instructions
    try:
        async with httpx.AsyncClient(timeout=20, trust_env=False) as client:
            r = await client.post(
                base + "/audio/speech",
                headers={"Authorization": f"Bearer {key}"},
                json=payload,
            )
    except httpx.HTTPError as e:
        return {"ok": False, "error": f"connection failed: {e}"}
    if r.status_code != 200:
        return {"ok": False, "error": f"HTTP {r.status_code}: {r.text[:200]}"}
    if not r.content:
        return {"ok": False, "error": "endpoint returned an empty audio body"}
    return {"ok": True, "bytes": len(r.content)}
