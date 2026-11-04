"""Settings: view/update provider config (secrets masked on read)."""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from .. import config
from ..providers import registry

router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingsPatch(BaseModel):
    confirm_exit: bool | None = None
    provider: str | None = None
    output_language: str | None = None
    target_language: str | None = None
    providers: dict | None = None
    feature_settings: dict | None = None
    tts: dict | None = None


@router.get("")
async def get_settings():
    return {
        "config": config.public_config(),
        "available_providers": registry.available(),
        "provider_statuses": registry.provider_statuses(),
    }


@router.get("/status")
async def get_provider_statuses():
    return {"provider_statuses": registry.provider_statuses()}


@router.post("")
async def update_settings(body: SettingsPatch):
    patch: dict = {}
    if body.confirm_exit is not None:
        patch["confirm_exit"] = body.confirm_exit
    if body.provider:
        patch["provider"] = body.provider
    if body.output_language:
        patch["output_language"] = body.output_language
    if body.target_language:
        patch["target_language"] = body.target_language
    if body.providers:
        # ignore masked api_key sentinel so we don't overwrite real keys with "set"
        cleaned = {}
        for name, p in body.providers.items():
            pc = dict(p)
            if pc.get("api_key") in ("set", ""):
                pc.pop("api_key", None)
            cleaned[name] = pc
        patch["providers"] = cleaned
        for name in cleaned:
            registry.reset_status(name)
    if body.feature_settings is not None:
        patch["feature_settings"] = body.feature_settings
    if body.tts is not None:
        tc = dict(body.tts)
        # ignore the masked api_key sentinel so we never overwrite a real key with "set"
        if tc.get("api_key") in ("set", ""):
            tc.pop("api_key", None)
        patch["tts"] = tc
    config.save_config(patch)
    return {"config": config.public_config()}


class TestBody(BaseModel):
    provider: str | None = None


@router.post("/test")
async def test_provider(body: TestBody):
    """Check connectivity; local CLIs use their fast login-status command."""
    provider = body.provider or config.load_config().get("provider")
    return await registry.test_connection(provider)
