"""Read-aloud (TTS) endpoints and helpers — no real network.

The gateway is faked two ways:
- unit tests call the feature module with a stubbed httpx transport, and
- endpoint tests monkeypatch ``app.features.tts.synthesize`` so /api/tts/speak
  exercises routing/validation/caching without any socket.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from app.features import tts as tts_feat


def _configure(client, **overrides):
    cfg = {
        "base_url": "https://tts.example.com/v1",
        "api_key": "sk-test-tts-key-123",
        "model": "edge-tts/en-AU-WilliamMultilingualNeural",
        "voice": "",
        "response_format": "mp3",
        "speed": 1.0,
        "timeout": 30,
    }
    cfg.update(overrides)
    r = client.post("/api/settings", json={"tts": cfg})
    assert r.status_code == 200, r.text


# ---------------------------------------------------------------------------
# Config handling
# ---------------------------------------------------------------------------

def test_settings_mask_tts_api_key(client):
    _configure(client)
    got = client.get("/api/settings")
    assert got.status_code == 200
    cfg = got.json()["config"]["tts"]
    assert cfg["api_key"] == "set"  # masked, never the raw secret
    assert cfg["base_url"] == "https://tts.example.com/v1"
    assert cfg["model"] == "edge-tts/en-AU-WilliamMultilingualNeural"


def test_settings_patch_does_not_overwrite_saved_key_with_sentinel(client):
    _configure(client)
    # the UI sends the masked sentinel back — the real key must survive
    r = client.post("/api/settings", json={"tts": {"api_key": "set", "model": "tts-1"}})
    assert r.status_code == 200
    assert tts_feat.tts_settings()["api_key"] == "sk-test-tts-key-123"
    assert tts_feat.tts_settings()["model"] == "tts-1"


def test_tts_settings_clamps_and_normalizes(client):
    _configure(client, speed=99, response_format="exe")
    s = tts_feat.tts_settings()
    assert s["speed"] == 4.0  # clamped to the OpenAI range
    assert s["response_format"] == "mp3"  # unknown formats fall back


# ---------------------------------------------------------------------------
# Text preparation
# ---------------------------------------------------------------------------

def test_clean_for_speech_strips_citations_urls_and_hyphens():
    raw = "A sen-\ntence [1, 2] with (see figure 3) and https://example.com/x plus doi:10.1/xy end."
    out = tts_feat.clean_for_speech(raw)
    assert "sentence" in out          # hyphen-linebreak rejoined
    assert "[1" not in out            # citation markers gone
    assert "figure" not in out
    assert "example.com" not in out   # bare URLs gone
    assert "doi:" not in out


def test_chunk_text_respects_limit_and_sentence_boundaries():
    text = " ".join(f"Sentence number {i} is here." for i in range(200))
    chunks = tts_feat.chunk_text(text, max_chars=300)
    assert chunks
    assert all(len(c) <= 300 for c in chunks)
    # every chunk ends at a sentence boundary (no mid-word cuts)
    assert all(c.endswith(".") for c in chunks)
    # nothing was lost or duplicated
    assert sum(len(c.split(" ")) for c in chunks) == len(text.split(" "))


def test_chunk_text_short_input_is_single_chunk():
    assert tts_feat.chunk_text("Hello world.", max_chars=100) == ["Hello world."]
    assert tts_feat.chunk_text("   ", max_chars=100) == []


def test_chunk_text_hard_splits_pathological_sentences():
    # one giant "sentence" with no terminal punctuation
    text = "word " * 2000
    chunks = tts_feat.chunk_text(text, max_chars=500)
    assert all(len(c) <= 500 for c in chunks)
    assert "".join(chunks).replace(" ", "") == text.replace(" ", "")


# ---------------------------------------------------------------------------
# Synthesis (stubbed transport) + disk cache
# ---------------------------------------------------------------------------

def test_synthesize_roundtrip_and_disk_cache(tmp_path, monkeypatch):
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append({"url": str(request.url), "body": request.read()})
        return httpx.Response(200, content=b"FAKE_MP3_BYTES")

    transport = httpx.MockTransport(handler)

    class FakeClient(httpx.AsyncClient):
        def __init__(self, **kwargs):
            kwargs.pop("proxy", None)
            super().__init__(transport=transport, **kwargs)

    monkeypatch.setattr(tts_feat, "external_client", lambda **kwargs: FakeClient(**kwargs))
    monkeypatch.setattr(tts_feat, "_TTS_DIR", tmp_path)

    _apply_config(monkeypatch, base_url="https://tts.example.com/v1",
                  api_key="sk-x", model="m1")

    audio = asyncio.run(tts_feat.synthesize("Hello from the test."))
    assert audio == b"FAKE_MP3_BYTES"
    assert len(calls) == 1
    # request shape matches the OpenAI /audio/speech contract
    import json
    body = json.loads(calls[0]["body"])
    assert body["model"] == "m1"
    assert body["input"] == "Hello from the test."
    assert body["response_format"] == "mp3"
    assert calls[0]["url"].endswith("/v1/audio/speech")

    # second call is served from the disk cache (no extra HTTP request)
    again = asyncio.run(tts_feat.synthesize("Hello from the test."))
    assert again == audio
    assert len(calls) == 1
    assert list(tmp_path.glob("*.mp3")), "cache file was written"


def test_synthesize_requires_configuration(monkeypatch):
    _apply_config(monkeypatch, base_url="", api_key="", model="")
    with pytest.raises(ValueError, match="not configured"):
        asyncio.run(tts_feat.synthesize("Hello"))


def test_synthesize_raises_endpoint_errors(tmp_path, monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="bad key")

    transport = httpx.MockTransport(handler)

    class FakeClient(httpx.AsyncClient):
        def __init__(self, **kwargs):
            kwargs.pop("proxy", None)
            super().__init__(transport=transport, **kwargs)

    monkeypatch.setattr(tts_feat, "external_client", lambda **kwargs: FakeClient(**kwargs))
    monkeypatch.setattr(tts_feat, "_TTS_DIR", tmp_path)
    _apply_config(monkeypatch, base_url="https://tts.example.com/v1",
                  api_key="sk-bad", model="m1")
    with pytest.raises(ValueError, match="401"):
        asyncio.run(tts_feat.synthesize("Hello"))


def test_trim_cache_evicts_oldest_files(tmp_path, monkeypatch):
    import os
    import time

    monkeypatch.setattr(tts_feat, "_TTS_DIR", tmp_path)
    old = tmp_path / "old.mp3"
    new = tmp_path / "new.mp3"
    old.write_bytes(b"x" * 100)
    new.write_bytes(b"y" * 100)
    long_ago = time.time() - 10_000
    os.utime(old, (long_ago, long_ago))
    tts_feat.trim_cache(max_bytes=150)
    assert not old.exists()  # least-recently-used evicted first
    assert new.exists()




# ---------------------------------------------------------------------------
# Endpoints (synthesize monkeypatched — no network)
# ---------------------------------------------------------------------------

def test_speak_text_returns_audio(client, paper_id, monkeypatch):
    _configure(client)
    monkeypatch.setattr(tts_feat, "synthesize", _fake_synthesize)
    r = client.post("/api/tts/speak", json={"text": "Hello from the test."})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "audio/mpeg"
    assert r.content == b"FAKE_MP3_BYTES"


def test_speak_page_uses_parsed_paper_text(client, paper_id, monkeypatch, pdf_meta):
    _configure(client)
    seen: list[str] = []

    async def fake(text: str) -> bytes:
        seen.append(text)
        return b"FAKE_MP3_BYTES"

    monkeypatch.setattr(tts_feat, "synthesize", fake)
    r = client.post("/api/tts/speak", json={"paper_id": paper_id, "page": 0})
    assert r.status_code == 200, r.text
    # the page's real extracted text (title etc.) was sent for synthesis
    assert pdf_meta["title"] in seen[0]


def test_speak_validates_its_input(client, paper_id, monkeypatch):
    _configure(client)
    monkeypatch.setattr(tts_feat, "synthesize", _fake_synthesize)
    # neither text nor paper_id+page
    assert client.post("/api/tts/speak", json={}).status_code == 400
    # page out of range
    r = client.post("/api/tts/speak", json={"paper_id": paper_id, "page": 99})
    assert r.status_code == 400
    # unknown paper
    r = client.post("/api/tts/speak", json={"paper_id": "nope", "page": 0})
    assert r.status_code == 400


def _apply_config(monkeypatch, **overrides):
    """Point the feature module at an in-memory settings dict for one test."""
    cfg = {
        "base_url": "https://tts.example.com/v1",
        "api_key": "sk-test",
        "model": "edge-tts/test",
        "voice": "",
        "response_format": "mp3",
        "speed": 1.0,
        "timeout": 30,
    }
    cfg.update(overrides)
    # patch the module-level name the feature actually calls
    monkeypatch.setattr(tts_feat, "tts_settings", lambda: cfg)


@pytest.fixture(autouse=True)
def _reset_tts_config(client):
    """The persisted config is shared across the session — clear TTS after each
    test so later files (and the 'unconfigured' cases here) see clean state."""
    yield
    client.post("/api/settings", json={
        "tts": {
            "base_url": "",
            "api_key": "",
            "model": "",
            "voice": "",
            "response_format": "mp3",
            "speed": 1.0,
        }
    })


async def _fake_synthesize(text: str) -> bytes:  # noqa: ARG001
    return b"FAKE_MP3_BYTES"


def test_synthesize_splits_long_text_and_joins_audio(tmp_path, monkeypatch):
    """Long input goes to the endpoint in <=1,200-char pieces, audio is joined."""
    import json as _json

    requests: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(_json.loads(request.read()))
        return httpx.Response(200, content=b"AB")

    transport = httpx.MockTransport(handler)

    class FakeClient(httpx.AsyncClient):
        def __init__(self, **kwargs):
            kwargs.pop("proxy", None)
            super().__init__(transport=transport, **kwargs)

    monkeypatch.setattr(tts_feat, "external_client", lambda **kwargs: FakeClient(**kwargs))
    monkeypatch.setattr(tts_feat, "_TTS_DIR", tmp_path)
    _apply_config(monkeypatch)

    long_text = " ".join(f"Sentence number {i} is here." for i in range(150))
    audio = asyncio.run(tts_feat.synthesize(long_text))
    assert audio == b"AB" * len(requests)  # chunk outputs joined in order
    assert len(requests) > 1
    assert all(len(r["input"]) <= 1200 for r in requests)
    assert " ".join(r["input"] for r in requests).count("Sentence") == 150


def test_synthesize_bisects_on_server_errors(tmp_path, monkeypatch):
    """A 5xx on a chunk is retried as two smaller requests instead of failing."""
    import json as _json

    seen_sizes: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = _json.loads(request.read())
        seen_sizes.append(len(body["input"]))
        # fail anything longer than 400 chars, like a picky relay
        if len(body["input"]) > 400:
            return httpx.Response(502, text="Bing TTS failed: 504")
        return httpx.Response(200, content=b"OK")

    transport = httpx.MockTransport(handler)

    class FakeClient(httpx.AsyncClient):
        def __init__(self, **kwargs):
            kwargs.pop("proxy", None)
            super().__init__(transport=transport, **kwargs)

    monkeypatch.setattr(tts_feat, "external_client", lambda **kwargs: FakeClient(**kwargs))
    monkeypatch.setattr(tts_feat, "_TTS_DIR", tmp_path)
    # force one oversized chunk so the bisect path must save us
    monkeypatch.setattr(tts_feat, "chunk_text", lambda text, max_chars=1200: [text])
    _apply_config(monkeypatch)

    audio = asyncio.run(tts_feat.synthesize("word " * 120))
    assert audio == b"OK" * (len(seen_sizes) - 1)
    # the retry pieces were all under the relay's limit
    assert all(size <= 400 for size in seen_sizes[1:])
