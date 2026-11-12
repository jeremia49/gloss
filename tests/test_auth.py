"""Tests for optional internet-facing password protection."""
from __future__ import annotations


def test_auth_disabled_keeps_local_workflow_open(client):
    assert client.get("/api/papers").status_code == 200
    response = client.get("/login", follow_redirects=False)
    assert response.status_code == 303
    assert response.headers["location"] == "/"


def test_password_login_protects_api_and_spa(client, monkeypatch):
    monkeypatch.setenv("GLOSS_PASSWORD", "correct horse battery staple")
    monkeypatch.setenv("GLOSS_USERNAME", "reader")
    try:
        assert client.get("/api/papers").status_code == 401
        assert client.get("/api/health").status_code == 200

        page = client.get("/login")
        assert page.status_code == 200
        assert "Sign in" in page.text

        navigation = client.get(
            "/", headers={"accept": "text/html"}, follow_redirects=False
        )
        assert navigation.status_code == 303
        assert navigation.headers["location"].startswith("/login?next=")

        wrong = client.post(
            "/login",
            data={"username": "reader", "password": "wrong", "next": "/"},
            follow_redirects=False,
        )
        assert wrong.status_code == 401
        assert "Incorrect username or password" in wrong.text
        assert client.get("/api/papers").status_code == 401

        login = client.post(
            "/login",
            data={"username": "reader", "password": "correct horse battery staple", "next": "/"},
            follow_redirects=False,
        )
        assert login.status_code == 303
        assert login.headers["location"] == "/"
        cookie = login.headers["set-cookie"].lower()
        assert "httponly" in cookie
        assert "samesite=lax" in cookie
        assert client.get("/api/papers").status_code == 200

        # Only same-origin paths are accepted as post-login destinations.
        unsafe = client.post(
            "/login",
            data={"username": "reader", "password": "correct horse battery staple", "next": "//evil.example"},
            follow_redirects=False,
        )
        assert unsafe.status_code == 303
        assert unsafe.headers["location"] == "/"

        # Changing the password revokes sessions signed with the old password.
        monkeypatch.setenv("GLOSS_PASSWORD", "a different password")
        assert client.get("/api/papers").status_code == 401

        relogin = client.post(
            "/login",
            data={"username": "reader", "password": "a different password", "next": "/"},
            follow_redirects=False,
        )
        assert relogin.status_code == 303
        assert client.get("/api/papers").status_code == 200

        logout = client.get("/logout", follow_redirects=False)
        assert logout.status_code == 303
        assert logout.headers["location"] == "/login"
        assert client.get("/api/papers").status_code == 401
    finally:
        client.cookies.clear()


def test_require_auth_rejects_missing_or_weak_password(monkeypatch):
    from app import auth

    monkeypatch.setenv("GLOSS_REQUIRE_AUTH", "1")
    for value in (None, "short", "replace-with-a-long-random-password"):
        if value is None:
            monkeypatch.delenv("GLOSS_PASSWORD", raising=False)
        else:
            monkeypatch.setenv("GLOSS_PASSWORD", value)
        try:
            auth.validate_startup()
        except RuntimeError as exc:
            assert "GLOSS_PASSWORD" in str(exc)
        else:
            raise AssertionError(f"GLOSS_REQUIRE_AUTH=1 accepted password {value!r}")