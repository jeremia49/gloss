"""Read papers aloud — text-to-speech via an OpenAI-compatible /v1/audio/speech endpoint.

Works against real OpenAI tts-1/tts-1-hd or ANY compatible gateway (e.g. an
edge-tts proxy at https://9router.jeremia.my.id/v1). Text is chunked to
~2,000-character pieces (endpoints reject long inputs), each chunk is cached on
disk keyed by (text, model, voice, format, speed) so replay is instant and free.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

import httpx

from ..config import CACHE_DIR, load_config
from ..library import store
from ..net import external_client

# endpoints reject or time out on long inputs; ~1.2k chars is safely inside
# every gateway we've seen (Bing/edge-tts relays start failing near 1.7k)
_CHUNK_CHARS = 1200
_TTS_DIR = CACHE_DIR / "tts"
# PDF text often carries citation markers and ligature junk that reads badly
_STRIP = re.compile(r"(\[\d{1,3}(?:,\s*\d{1,3})*\]|\((?:see\s+)?fig(?:ure)?\.?\s*\d+[a-z]?(?:[^\)]{0,40})\)|\bdoi:\s*\S+|https?://\S+|[\u00ad\u200b\u2060])", re.IGNORECASE)
_HYPHEN_BREAK = re.compile(r"(\w)-\n(\w)")


def tts_settings() -> dict:
    cfg = load_config().get("tts", {}) or {}
    speed = cfg.get("speed", 1.0)
    try:
        speed = min(4.0, max(0.25, float(speed)))
    except (TypeError, ValueError):
        speed = 1.0
    fmt = (cfg.get("response_format") or "mp3").lower()
    if fmt not in {"mp3", "opus", "aac", "flac", "wav"}:
        fmt = "mp3"
    return {
        "base_url": (cfg.get("base_url") or "").strip(),
        "api_key": (cfg.get("api_key") or "").strip(),
        "model": (cfg.get("model") or "").strip(),
        "voice": (cfg.get("voice") or "").strip(),
        "response_format": fmt,
        "speed": speed,
        "timeout": cfg.get("timeout", 120),
    }


def is_configured() -> bool:
    s = tts_settings()
    return bool(s["base_url"] and s["api_key"] and s["model"])


def clean_for_speech(text: str) -> str:
    """Normalise extracted PDF text into something pleasant to hear."""
    text = text.replace("\r", "\n")
    text = _HYPHEN_BREAK.sub(r"\1\2", text)      # rejoin words split across lines
    text = _STRIP.sub(" ", text)                  # citation markers, bare URLs
    text = text.replace("-\n", " ")
    # collapse whitespace but keep a pause between paragraphs/lines
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\s*\n\s*", "\n", text)
    return text.strip()


def chunk_text(text: str, max_chars: int = _CHUNK_CHARS) -> list[str]:
    """Split speech text into endpoint-sized chunks, preferring sentence/line breaks."""
    text = text.strip()
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]
    units: list[str] = []  # sentences and paragraph breaks, in order
    for para in text.split("\n"):
        if not para.strip():
            units.append("\n")
            continue
        start = 0
        for m in re.finditer(r"[.!?](?:\s|$)", para):
            sent = para[start : m.end()].strip()
            if sent:
                units.append(sent)
            start = m.end()
        rest = para[start:].strip()
        if rest:
            units.append(rest)
    chunks: list[str] = []
    cur = ""
    for unit in units:
        if unit == "\n":
            if cur:
                cur += "\n"
            continue
        if len(unit) > max_chars:  # pathological sentence: hard-split on words
            for i in range(0, len(unit), max_chars):
                piece = unit[i : i + max_chars]
                if cur and len(cur) + 1 + len(piece) > max_chars:
                    chunks.append(cur.strip())
                    cur = ""
                cur += (" " if cur else "") + piece
            continue
        if cur and len(cur) + 1 + len(unit) > max_chars:
            chunks.append(cur.strip())
            cur = unit
        else:
            cur = cur + (" " if cur and not cur.endswith("\n") else "") + unit if cur else unit
    if cur.strip():
        chunks.append(cur.strip())
    return [c for c in chunks if c]


def _cache_key(text: str, s: dict) -> str:
    raw = "\x00".join(
        ["v1", text, s["model"], s["voice"], s["response_format"], f"{s['speed']:g}"]
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _cache_path(key: str, fmt: str) -> Path:
    return _TTS_DIR / f"{key}.{fmt}"


async def synthesize(text: str) -> bytes:
    """Synthesize speech audio (cached on disk). Raises ValueError when unconfigured.

    Long inputs are chunked to ~1,200 characters (OpenAI-style endpoints and
    edge-tts gateways both reject or time out on long single requests); each
    chunk is cached separately so replay is instant. If a gateway still fails
    on a chunk with a server error, the chunk is retried split in half.
    """
    s = tts_settings()
    if not (s["base_url"] and s["api_key"] and s["model"]):
        raise ValueError(
            "TTS is not configured — set a base_url, api_key and model in Settings"
        )
    text = clean_for_speech(text)
    if not text:
        raise ValueError("nothing to speak")
    chunks = chunk_text(text, max_chars=_CHUNK_CHARS)
    parts: list[bytes] = []
    for chunk in chunks:
        parts.append(await _synthesize_chunk(chunk, s))
    return b"".join(parts)


async def _synthesize_chunk(text: str, s: dict) -> bytes:
    """One cached HTTP call for a single chunk; bisect-retries server errors."""
    key = _cache_key(text, s)
    path = _cache_path(key, s["response_format"])
    if path.exists():
        return path.read_bytes()

    url = s["base_url"].rstrip("/") + "/audio/speech"
    body: dict = {
        "model": s["model"],
        "input": text,
        "response_format": s["response_format"],
    }
    if s["voice"]:
        body["voice"] = s["voice"]
    if s["speed"] != 1.0:
        body["speed"] = s["speed"]
    headers = {
        "Authorization": f"Bearer {s['api_key']}",
        "Content-Type": "application/json",
    }
    # external_client() honours the machine's HTTP proxy like every other
    # outbound call in Gloss (the local claude_proxy stays direct).
    async with external_client(timeout=s["timeout"], headers=headers) as client:
        r = await client.post(url, json=body)
        if r.status_code != 200:
            detail = r.text[:300].strip()
            # A 5xx from the gateway is often "input too long" in disguise
            # (edge-tts relays Bing's 504s). Retry smaller before giving up —
            # but only while halving still leaves something to say.
            half = len(text) // 2
            split = text.rfind(" ", 0, half) + 1 or half
            if 500 <= r.status_code < 600 and len(text) > 200 and split < len(text):
                first = await _synthesize_chunk(text[:split].strip(), s)
                second = await _synthesize_chunk(text[split:].strip(), s)
                return first + second
            raise ValueError(
                f"TTS endpoint returned {r.status_code}: {detail or 'no detail'}"
            )
        audio = r.content
    if not audio:
        raise ValueError("TTS endpoint returned an empty audio body")
    _TTS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(audio)
    tmp.replace(path)
    trim_cache()
    return audio


def page_text(paper_id: str, page: int) -> str:
    """Reading-ordered text of one page (0-based) from the parsed blocks."""
    parsed = store.load_parsed(paper_id)
    if not parsed:
        raise ValueError("paper not parsed")
    n = parsed.get("n_pages", 0)
    if page < 0 or page >= n:
        raise ValueError(f"page out of range (0..{n - 1})")
    p = parsed["pages"][page]
    blocks = sorted(p.get("blocks", []), key=lambda b: (b["bbox"][1], b["bbox"][0]))
    return "\n".join(b.get("text", "").strip() for b in blocks if b.get("text"))


def trim_cache(max_bytes: int = 512 * 1024 * 1024) -> None:
    """Keep the TTS audio cache under ~max_bytes (least-recently-used first)."""
    if not _TTS_DIR.exists():
        return
    files = [f for f in _TTS_DIR.iterdir() if f.is_file()]
    total = sum(f.stat().st_size for f in files)
    if total <= max_bytes:
        return
    files.sort(key=lambda f: f.stat().st_atime)
    for f in files:
        if total <= max_bytes:
            break
        try:
            size = f.stat().st_size
            f.unlink()
            total -= size
        except OSError:
            pass
