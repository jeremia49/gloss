"""Optional password protection for Gloss over the internet.

Authentication is enabled by setting ``GLOSS_PASSWORD``. The browser gets a
signed, HttpOnly session cookie after signing in on ``/login``; every other
request (including PDFs, uploads, and the API) requires that cookie. This keeps
the app's existing same-origin frontend unchanged.

``GLOSS_REQUIRE_AUTH=1`` makes startup fail when no password is configured, so a
public deployment cannot accidentally come up unauthenticated.

Sessions are stateless HMAC tokens (``expiry.signature``) signed with
``GLOSS_SECRET_KEY`` when provided, otherwise a random secret persisted in the
data directory. Changing the secret (or setting a new one) invalidates all
sessions. Failed logins are rate-limited in memory per client address.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets
import threading
import time
from collections import deque
from html import escape
from urllib.parse import quote

from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

from . import config

logger = logging.getLogger(__name__)

COOKIE_NAME = "gloss_session"
PUBLIC_PATHS = frozenset({"/login", "/logout", "/api/health"})
SESSION_DAYS_DEFAULT = 30
LOGIN_WINDOW_SECONDS = 600
LOGIN_MAX_FAILURES = 10

_secret_lock = threading.Lock()
_secret_cache: dict[tuple[str, str], bytes] = {}
_failure_lock = threading.Lock()
_failures: dict[str, deque[float]] = {}


def password() -> str:
    return os.environ.get("GLOSS_PASSWORD", "")


def username() -> str:
    return os.environ.get("GLOSS_USERNAME", "gloss")


def enabled() -> bool:
    return bool(password())


_PLACEHOLDER_PASSWORDS = {
    "change-me",
    "password",
    "replace-with-a-long-random-password",
}


def validate_startup() -> None:
    if os.environ.get("GLOSS_REQUIRE_AUTH") != "1":
        return
    if not enabled():
        raise RuntimeError(
            "GLOSS_REQUIRE_AUTH=1 but GLOSS_PASSWORD is not set. "
            "Set GLOSS_PASSWORD before exposing Gloss to the internet."
        )
    value = password()
    if len(value) < 12 or value.strip().lower() in _PLACEHOLDER_PASSWORDS:
        raise RuntimeError(
            "GLOSS_PASSWORD must be at least 12 characters and must not be the "
            "example placeholder. Generate one with: openssl rand -hex 24"
        )


def _session_days() -> int:
    try:
        days = int(os.environ.get("GLOSS_SESSION_DAYS", SESSION_DAYS_DEFAULT))
    except ValueError:
        days = SESSION_DAYS_DEFAULT
    return max(1, min(days, 365))


def _signing_secret() -> bytes:
    configured = os.environ.get("GLOSS_SECRET_KEY", "")
    cache_key = (password(), configured)
    with _secret_lock:
        cached = _secret_cache.get(cache_key)
        if cached is not None:
            return cached

        if configured:
            base = hashlib.sha256(configured.encode("utf-8")).digest()
        else:
            path = config.DATA_DIR / "auth_secret"
            try:
                base = path.read_bytes()
                if len(base) < 32:
                    raise OSError("short secret")
            except OSError:
                base = secrets.token_bytes(32)
                path.write_bytes(base)
                try:
                    path.chmod(0o600)
                except OSError:
                    pass

        # Binding to the password means changing GLOSS_PASSWORD revokes every
        # existing session instead of leaving old cookies valid until expiry.
        derived = hmac.new(base, password().encode("utf-8"), hashlib.sha256).digest()
        _secret_cache[cache_key] = derived
        return derived


def _issue_session(expires_at: int) -> str:
    message = str(expires_at).encode("ascii")
    signature = hmac.new(_signing_secret(), message, hashlib.sha256).hexdigest()
    return f"{expires_at}.{signature}"


def _valid_session(token: str | None) -> bool:
    if not token or "." not in token:
        return False
    raw_expiry, signature = token.rsplit(".", 1)
    try:
        expires_at = int(raw_expiry)
    except ValueError:
        return False
    if expires_at < int(time.time()):
        return False
    expected = hmac.new(
        _signing_secret(), raw_expiry.encode("ascii"), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, expected)


def _credentials_match(user: str, supplied: str) -> bool:
    expected_user = username()
    expected_password = password()
    user_ok = secrets.compare_digest(user.encode("utf-8"), expected_user.encode("utf-8"))
    password_ok = secrets.compare_digest(
        supplied.encode("utf-8"), expected_password.encode("utf-8")
    )
    return user_ok and password_ok


def _is_https(request: Request) -> bool:
    return request.url.scheme == "https"


def _safe_next(value: str) -> str:
    if not value.startswith("/") or value.startswith("//") or "\\" in value:
        return "/"
    return value


def _login_redirect(request: Request) -> str:
    path = request.url.path or "/"
    if request.url.query:
        path = f"{path}?{request.url.query}"
    return f"/login?next={quote(path, safe='')}"


def _client_key(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _failure_count(key: str) -> int:
    cutoff = time.monotonic() - LOGIN_WINDOW_SECONDS
    with _failure_lock:
        attempts = _failures.get(key)
        if attempts is None:
            return 0
        while attempts and attempts[0] < cutoff:
            attempts.popleft()
        if not attempts:
            _failures.pop(key, None)
            return 0
        return len(attempts)


def _record_failure(key: str) -> None:
    now = time.monotonic()
    with _failure_lock:
        attempts = _failures.setdefault(key, deque())
        attempts.append(now)
        # Bound memory under a distributed guessing attack. Rotating source
        # addresses can already reset the limiter, so trading a reset for a hard
        # memory ceiling is the right call.
        if len(_failures) > 4096:
            _failures.clear()
            _failures[key] = attempts


def _clear_failures(key: str) -> None:
    with _failure_lock:
        _failures.pop(key, None)


def _login_page(next_url: str, error: str = "") -> str:
    error_html = f'<p class="error" role="alert">{escape(error)}</p>' if error else ""
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f1216">
<title>Gloss · Sign in</title>
<style>
  :root {{ color-scheme: dark; }}
  * {{ box-sizing: border-box; }}
  html, body {{ height: 100%; margin: 0; }}
  body {{
    display: grid; place-items: center; padding: max(24px, env(safe-area-inset-top)) 24px;
    background: #0f1216; color: #e6e9ef;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }}
  form {{
    width: min(380px, 100%); padding: 26px; border: 1px solid #262d38;
    border-radius: 14px; background: #161b22;
  }}
  h1 {{ margin: 0 0 6px; font-size: 22px; }}
  p {{ margin: 0 0 18px; color: #9aa4b2; font-size: 13px; line-height: 1.45; }}
  label {{ display: block; margin: 12px 0 5px; color: #9aa4b2; font-size: 12px; }}
  input {{
    width: 100%; height: 46px; padding: 0 12px; border: 1px solid #262d38;
    border-radius: 8px; background: #0f1216; color: #e6e9ef; font-size: 16px;
  }}
  input:focus {{ outline: none; border-color: #7aa2f7; box-shadow: 0 0 0 2px #7aa2f733; }}
  button {{
    width: 100%; height: 46px; margin-top: 18px; border: 0; border-radius: 8px;
    background: #7aa2f7; color: #0b0e13; font-size: 15px; font-weight: 700;
  }}
  button:active {{ opacity: .82; }}
  .error {{ color: #ef6b6b; font-size: 13px; }}
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>Gloss 旁注</h1>
  <p>Enter the server password to read your library.</p>
  {error_html}
  <input type="hidden" name="next" value="{escape(next_url, quote=True)}">
  <label for="username">Username</label>
  <input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
  <button type="submit">Sign in</button>
</form>
</body>
</html>"""


class AuthMiddleware:
    """Pure ASGI middleware so streaming AI responses are never buffered."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if not enabled() or path in PUBLIC_PATHS:
            await self.app(scope, receive, send)
            return

        request = Request(scope)
        if _valid_session(request.cookies.get(COOKIE_NAME)):
            await self.app(scope, receive, send)
            return

        accept = request.headers.get("accept", "")
        if scope.get("method") in ("GET", "HEAD") and "text/html" in accept:
            response = RedirectResponse(_login_redirect(request), status_code=303)
        else:
            response = JSONResponse({"detail": "authentication required"}, status_code=401)
        await response(scope, receive, send)


def _rate_limited(request: Request) -> bool:
    return _failure_count(_client_key(request)) >= LOGIN_MAX_FAILURES


def install(app: FastAPI) -> None:
    """Register the middleware and the login/logout routes."""
    app.add_middleware(AuthMiddleware)

    @app.get("/login", response_class=HTMLResponse, include_in_schema=False)
    async def login_form(request: Request, next: str = "/"):
        target = _safe_next(next)
        if not enabled():
            return RedirectResponse("/", status_code=303)
        if _valid_session(request.cookies.get(COOKIE_NAME)):
            return RedirectResponse(target, status_code=303)
        return HTMLResponse(_login_page(target))

    @app.post("/login", response_class=HTMLResponse, include_in_schema=False)
    async def login_submit(
        request: Request,
        username: str = Form(""),
        password: str = Form(""),
        next: str = Form("/"),
    ):
        target = _safe_next(next)
        if not enabled():
            return RedirectResponse("/", status_code=303)

        key = _client_key(request)
        if _rate_limited(request):
            return HTMLResponse(
                _login_page(target, "Too many attempts. Try again in a few minutes."),
                status_code=429,
                headers={"Retry-After": str(LOGIN_WINDOW_SECONDS)},
            )
        if not _credentials_match(username, password):
            _record_failure(key)
            logger.warning("Failed Gloss sign-in from %s", key)
            return HTMLResponse(
                _login_page(target, "Incorrect username or password."),
                status_code=401,
            )

        _clear_failures(key)
        max_age = _session_days() * 86400
        expires_at = int(time.time()) + max_age
        response = RedirectResponse(target, status_code=303)
        response.set_cookie(
            COOKIE_NAME,
            _issue_session(expires_at),
            max_age=max_age,
            httponly=True,
            samesite="lax",
            secure=_is_https(request),
            path="/",
        )
        logger.info("Successful Gloss sign-in from %s", key)
        return response

    @app.get("/logout", include_in_schema=False)
    async def logout(request: Request):
        target = "/login" if enabled() else "/"
        response = RedirectResponse(target, status_code=303)
        response.delete_cookie(COOKIE_NAME, path="/", secure=_is_https(request))
        return response