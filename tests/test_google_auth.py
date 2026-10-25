import time
import uuid
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from planner import google_routes, main
from planner.config import Settings, get_settings
from planner.db import Base, get_session
from planner.google_accounts import (
    GoogleLinkError,
    connect_calendar,
    sign_in_with_google,
)
from planner.google_client import (
    CALENDAR_SCOPE,
    GoogleIdentity,
    GoogleTokens,
    authorization_url,
    decrypt_token,
)
from planner.models import AuthSession, GoogleAccount, GoogleEventLink, User
from planner.security import current_user, hash_password, verify_password

IDENTITY = GoogleIdentity(subject="sub-1", email="person@example.com", email_verified=True)
CALENDAR_TOKENS = GoogleTokens("access", "refresh-secret", f"openid email {CALENDAR_SCOPE}")


@pytest.fixture
def settings(monkeypatch):
    monkeypatch.setenv("GOOGLE_CALENDAR_CLIENT_ID", "client-id")
    monkeypatch.setenv("GOOGLE_CALENDAR_CLIENT_SECRET", "client-secret")
    monkeypatch.setenv("CALENDAR_TOKEN_KEY", "token-key")
    monkeypatch.setenv("FRONTEND_BASE_URL", "http://planner.test")
    get_settings.cache_clear()
    return get_settings()


@pytest.fixture
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as value:
        yield value
    await engine.dispose()


async def test_google_sign_in_registers_a_passwordless_user(session):
    user = await sign_in_with_google(session, IDENTITY)

    assert user.email == "person@example.com"
    assert not verify_password("anything-at-all", user.password_hash)
    assert (await session.get(GoogleAccount, user.id)).subject == "sub-1"
    assert (await sign_in_with_google(session, IDENTITY)).id == user.id


async def test_google_sign_in_links_an_existing_account_by_verified_email(session):
    existing = User(email="Person@Example.com", password_hash=hash_password("password-1"))
    session.add(existing)
    await session.flush()

    user = await sign_in_with_google(session, IDENTITY)

    assert user.id == existing.id
    assert verify_password("password-1", user.password_hash)


async def test_google_sign_in_rejects_unverified_email(session):
    with pytest.raises(GoogleLinkError) as error:
        await sign_in_with_google(
            session, GoogleIdentity(subject="x", email="person@example.com", email_verified=False)
        )
    assert error.value.code == "email_unverified"


async def test_google_sign_in_does_not_replace_another_linked_google_account(session):
    user = User(email="person@example.com", password_hash="")
    session.add(user)
    await session.flush()
    session.add(GoogleAccount(user_id=user.id, subject="other-sub", email="person@example.com"))
    await session.flush()

    with pytest.raises(GoogleLinkError) as error:
        await sign_in_with_google(session, IDENTITY)
    assert error.value.code == "linked_elsewhere"


async def test_connect_calendar_requires_calendar_scope_and_refresh_token(session, settings):
    user = User(email="person@example.com", password_hash="")
    session.add(user)
    await session.flush()

    with pytest.raises(GoogleLinkError) as error:
        await connect_calendar(
            session, settings, user, IDENTITY, GoogleTokens("access", None, "openid email")
        )
    assert error.value.code == "calendar_scope"


async def test_connecting_another_google_account_drops_old_links(session, settings):
    user = User(email="person@example.com", password_hash="")
    session.add(user)
    await session.flush()
    session.add(GoogleAccount(user_id=user.id, subject="old-sub", email="old@example.com"))
    session.add(
        GoogleEventLink(
            owner_id=user.id,
            series_id=uuid.uuid4(),
            version_id=uuid.uuid4(),
            google_event_id="old-event",
        )
    )
    await session.flush()

    account = await connect_calendar(session, settings, user, IDENTITY, CALENDAR_TOKENS)

    assert account.subject == "sub-1"
    assert account.calendar_enabled
    assert decrypt_token(settings, account.refresh_token_encrypted) == "refresh-secret"
    assert account.refresh_token_encrypted != "refresh-secret"
    assert (await session.scalars(select(GoogleEventLink))).all() == []


async def test_connect_calendar_rejects_a_google_account_of_another_user(session, settings):
    owner = User(email="owner@example.com", password_hash="")
    intruder = User(email="intruder@example.com", password_hash="")
    session.add_all([owner, intruder])
    await session.flush()
    session.add(GoogleAccount(user_id=owner.id, subject="sub-1", email="owner@example.com"))
    await session.flush()

    with pytest.raises(GoogleLinkError) as error:
        await connect_calendar(session, settings, intruder, IDENTITY, CALENDAR_TOKENS)
    assert error.value.code == "linked_elsewhere"


def test_state_is_signed_and_bound_to_the_browser_nonce(settings):
    state = google_routes.sign_state(
        settings, {"purpose": "login", "nonce": "n1", "exp": int(time.time()) + 60}
    )

    assert google_routes.verify_state(settings, state, "n1")["purpose"] == "login"
    for tampered, nonce in [
        (state, "other"),
        (state, None),
        (state[:-1] + ("0" if state[-1] != "0" else "1"), "n1"),
        (
            google_routes.sign_state(settings, {"purpose": "login", "nonce": "n1", "exp": 1}),
            "n1",
        ),
    ]:
        with pytest.raises(GoogleLinkError):
            google_routes.verify_state(settings, tampered, nonce)


def test_connect_url_requests_offline_calendar_access(settings):
    url = authorization_url(settings, "state", calendar=True)
    query = parse_qs(urlsplit(url).query)

    assert query["redirect_uri"] == ["http://planner.test/api/auth/google/callback"]
    assert CALENDAR_SCOPE in query["scope"][0].split()
    assert query["access_type"] == ["offline"]
    assert query["prompt"] == ["consent"]
    login = parse_qs(urlsplit(authorization_url(settings, "s", calendar=False)).query)
    assert CALENDAR_SCOPE not in login["scope"][0]


class FakeOAuthClient:
    def __init__(self, tokens: GoogleTokens = CALENDAR_TOKENS):
        self.tokens = tokens

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def exchange_code(self, code):
        assert code == "auth-code"
        return self.tokens

    async def identity(self, _access_token):
        return IDENTITY

    async def revoke(self, token):
        self.revoked = token


@pytest.fixture
async def api(session, settings, monkeypatch):
    async def database():
        yield session

    stored: dict[str, str] = {}
    scheduled: list[uuid.UUID] = []

    async def store(_settings, token):
        stored["code"] = token
        return "login-code"

    async def consume(_settings, code):
        return stored.get("code") if code == "login-code" else None

    async def schedule(owner_id, _settings):
        scheduled.append(owner_id)

    monkeypatch.setattr(google_routes, "google_client", lambda _settings: FakeOAuthClient())
    monkeypatch.setattr(google_routes, "store_login_token", store)
    monkeypatch.setattr(google_routes, "consume_login_token", consume)
    monkeypatch.setattr(google_routes, "schedule_google_sync", schedule)
    main.app.dependency_overrides[get_session] = database
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app), base_url="http://planner.test"
        ) as client:
            yield client, scheduled
    finally:
        main.app.dependency_overrides.clear()


async def test_google_login_flow_hands_a_session_to_the_spa(api, session):
    client, _ = api
    start = await client.get("/auth/google/login")
    assert start.status_code == 303
    state = parse_qs(urlsplit(start.headers["location"]).query)["state"][0]

    callback = await client.get(
        "/auth/google/callback", params={"state": state, "code": "auth-code"}
    )
    assert callback.status_code == 303
    assert callback.headers["location"] == "http://planner.test/?google_login=login-code"

    exchanged = await client.post("/auth/google/exchange", json={"code": "login-code"})
    assert exchanged.status_code == 200
    assert await session.scalar(select(AuthSession)) is not None
    assert (await client.post("/auth/google/exchange", json={"code": "bad"})).status_code == 401


async def test_callback_without_the_browser_nonce_is_rejected(api):
    client, _ = api
    start = await client.get("/auth/google/login")
    state = parse_qs(urlsplit(start.headers["location"]).query)["state"][0]
    client.cookies.clear()

    callback = await client.get(
        "/auth/google/callback", params={"state": state, "code": "auth-code"}
    )

    assert callback.headers["location"] == "http://planner.test/?google_error=state"


async def test_connect_flow_enables_calendar_sync(api, session):
    client, scheduled = api
    user = User(email="person@example.com", password_hash=hash_password("password-1"))
    session.add(user)
    await session.commit()
    main.app.dependency_overrides[current_user] = lambda: user

    assert (await client.get("/integrations/google")).json()["linked"] is False
    started = await client.post("/integrations/google/connect")
    state = parse_qs(urlsplit(started.json()["authorization_url"]).query)["state"][0]
    callback = await client.get(
        "/auth/google/callback", params={"state": state, "code": "auth-code"}
    )

    assert callback.headers["location"] == "http://planner.test/?google=connected"
    assert scheduled == [user.id]
    status = (await client.get("/integrations/google")).json()
    assert status["linked"] and status["calendar_enabled"]
    assert status["email"] == "person@example.com"

    assert (await client.delete("/integrations/google")).status_code == 204
    account = await session.get(GoogleAccount, user.id)
    assert not account.calendar_enabled and account.refresh_token_encrypted is None
    assert (await client.post("/integrations/google/sync")).status_code == 409


async def test_google_endpoints_are_hidden_when_not_configured(monkeypatch):
    unconfigured = Settings(llm_required=False, _env_file=None)
    monkeypatch.setattr(google_routes, "get_settings", lambda: unconfigured)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=main.app), base_url="http://planner.test"
    ) as client:
        assert (await client.get("/auth/google/config")).json() == {"enabled": False}
        assert (await client.get("/auth/google/login")).status_code == 404


def test_sync_errors_are_explained_to_the_owner():
    from planner.google_client import GoogleApiError
    from planner.google_sync_worker import describe_sync_error

    disabled = GoogleApiError(403, "Google Calendar API has not been used in project 1 before")
    assert "не включён Google Calendar API" in describe_sync_error(disabled)
    assert "временно недоступен" in describe_sync_error(GoogleApiError(503, "backend"))
    assert "Не удалось связаться" in describe_sync_error(httpx.ConnectError("dns"))
    assert "журнале" in describe_sync_error(RuntimeError("boom"))
