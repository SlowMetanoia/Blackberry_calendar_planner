"""Google sign-in and Google Calendar connection endpoints."""

import base64
import hashlib
import hmac
import json
import logging
import secrets
import time
import uuid
from datetime import datetime
from typing import Literal
from urllib.parse import urlencode

from arq import create_pool
from arq.connections import RedisSettings
from fastapi import APIRouter, Cookie, Depends, HTTPException
from fastapi.responses import JSONResponse, RedirectResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from .config import Settings, get_settings
from .db import get_session
from .google_accounts import (
    GoogleLinkError,
    connect_calendar,
    disconnect_calendar,
    sign_in_with_google,
)
from .google_client import GoogleApiError, GoogleClient, authorization_url
from .google_sync_worker import schedule_google_sync
from .models import GoogleAccount, User
from .schemas import TokenResponse
from .security import create_auth_session, current_user

logger = logging.getLogger(__name__)
router = APIRouter()
STATE_COOKIE = "planner_google_oauth"
STATE_TTL_SECONDS = 600
LOGIN_CODE_TTL_SECONDS = 120


class GoogleConfigResponse(BaseModel):
    enabled: bool


class AuthorizationUrlResponse(BaseModel):
    authorization_url: str


class GoogleExchangeRequest(BaseModel):
    code: str = Field(min_length=1, max_length=256)


class GoogleIntegrationResponse(BaseModel):
    available: bool
    linked: bool
    email: str | None = None
    calendar_enabled: bool = False
    sync_status: str | None = None
    last_synced_at: datetime | None = None
    last_error: str | None = None
    skipped_events: int = 0


def _require_google(settings: Settings) -> None:
    if not settings.google_enabled:
        raise HTTPException(404, "Интеграция с Google не настроена")


def _state_key(settings: Settings) -> bytes:
    return hashlib.sha256(f"google-oauth-state:{settings.calendar_token_key}".encode()).digest()


def sign_state(settings: Settings, payload: dict) -> str:
    raw = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode()
    signature = hmac.new(_state_key(settings), raw.encode(), hashlib.sha256).hexdigest()
    return f"{raw}.{signature}"


def verify_state(settings: Settings, state: str, nonce: str | None) -> dict:
    raw, _, signature = state.partition(".")
    expected = hmac.new(_state_key(settings), raw.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise GoogleLinkError("state")
    try:
        payload = json.loads(base64.urlsafe_b64decode(raw.encode()))
    except ValueError as exc:
        raise GoogleLinkError("state") from exc
    if (
        payload.get("exp", 0) < time.time()
        or not nonce
        or not hmac.compare_digest(str(payload.get("nonce")), nonce)
    ):
        raise GoogleLinkError("state")
    return payload


def _start(
    settings: Settings,
    *,
    purpose: Literal["login", "connect"],
    user_id: uuid.UUID | None = None,
) -> tuple[str, str]:
    """Return the Google authorization URL and the nonce bound to this browser."""
    nonce = secrets.token_urlsafe(24)
    state = sign_state(
        settings,
        {
            "purpose": purpose,
            "user_id": str(user_id) if user_id else None,
            "nonce": nonce,
            "exp": int(time.time()) + STATE_TTL_SECONDS,
        },
    )
    return authorization_url(settings, state, calendar=purpose == "connect"), nonce


def _with_state_cookie(response: Response, settings: Settings, nonce: str) -> Response:
    # The nonce cookie binds the callback to the browser that started the flow.
    response.set_cookie(
        STATE_COOKIE,
        nonce,
        max_age=STATE_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        secure=settings.frontend_base_url.startswith("https://"),
        path="/",
    )
    return response


def _frontend_redirect(settings: Settings, **params: str) -> RedirectResponse:
    response = RedirectResponse(
        f"{settings.frontend_base_url.rstrip('/')}/?{urlencode(params)}", status_code=303
    )
    response.delete_cookie(STATE_COOKIE, path="/")
    return response


def _login_code_key(code: str) -> str:
    return f"google-login:{hashlib.sha256(code.encode()).hexdigest()}"


async def store_login_token(settings: Settings, access_token: str) -> str:
    code = secrets.token_urlsafe(32)
    pool = await create_pool(RedisSettings.from_dsn(settings.redis_url))
    try:
        await pool.setex(_login_code_key(code), LOGIN_CODE_TTL_SECONDS, access_token)
    finally:
        await pool.close()
    return code


async def consume_login_token(settings: Settings, code: str) -> str | None:
    pool = await create_pool(RedisSettings.from_dsn(settings.redis_url))
    try:
        raw = await pool.execute_command("GETDEL", _login_code_key(code))
    finally:
        await pool.close()
    if raw is None:
        return None
    return raw.decode() if isinstance(raw, bytes) else str(raw)


def google_client(settings: Settings) -> GoogleClient:
    return GoogleClient(settings)


@router.get("/auth/google/config", response_model=GoogleConfigResponse)
async def google_config() -> GoogleConfigResponse:
    return GoogleConfigResponse(enabled=get_settings().google_enabled)


@router.get("/auth/google/login", include_in_schema=False)
async def google_login() -> RedirectResponse:
    settings = get_settings()
    _require_google(settings)
    url, nonce = _start(settings, purpose="login")
    return _with_state_cookie(RedirectResponse(url, status_code=303), settings, nonce)


@router.post("/integrations/google/connect", response_model=AuthorizationUrlResponse)
async def google_connect(user: User = Depends(current_user)) -> JSONResponse:
    settings = get_settings()
    _require_google(settings)
    url, nonce = _start(settings, purpose="connect", user_id=user.id)
    return _with_state_cookie(JSONResponse({"authorization_url": url}), settings, nonce)


@router.get("/auth/google/callback", include_in_schema=False)
async def google_callback(
    state: str = "",
    code: str | None = None,
    error: str | None = None,
    nonce: str | None = Cookie(default=None, alias=STATE_COOKIE),
    session: AsyncSession = Depends(get_session),
) -> RedirectResponse:
    settings = get_settings()
    _require_google(settings)
    try:
        payload = verify_state(settings, state, nonce)
        if error or not code:
            raise GoogleLinkError("denied")
        async with google_client(settings) as client:
            tokens = await client.exchange_code(code)
            identity = await client.identity(tokens.access_token)
        if payload["purpose"] == "login":
            user = await sign_in_with_google(session, identity)
            token, _ = await create_auth_session(session, user.id)
            await session.commit()
            return _frontend_redirect(
                settings, google_login=await store_login_token(settings, token)
            )
        user = await session.get(User, uuid.UUID(payload["user_id"]))
        if user is None:
            raise GoogleLinkError("state")
        await connect_calendar(session, settings, user, identity, tokens)
        await session.commit()
        await schedule_google_sync(user.id, settings)
        return _frontend_redirect(settings, google="connected")
    except GoogleLinkError as exc:
        await session.rollback()
        return _frontend_redirect(settings, google_error=exc.code)
    except (GoogleApiError, KeyError, ValueError) as exc:
        await session.rollback()
        logger.warning("Google OAuth callback failed: %s", exc)
        return _frontend_redirect(settings, google_error="failed")


@router.post("/auth/google/exchange", response_model=TokenResponse)
async def google_exchange(data: GoogleExchangeRequest) -> TokenResponse:
    token = await consume_login_token(get_settings(), data.code)
    if token is None:
        raise HTTPException(401, "Код входа через Google недействителен или истёк")
    return TokenResponse(access_token=token)


@router.get("/integrations/google", response_model=GoogleIntegrationResponse)
async def google_integration(
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> GoogleIntegrationResponse:
    settings = get_settings()
    account = await session.get(GoogleAccount, user.id)
    if account is None:
        return GoogleIntegrationResponse(available=settings.google_enabled, linked=False)
    return GoogleIntegrationResponse(
        available=settings.google_enabled,
        linked=True,
        email=account.email,
        calendar_enabled=account.calendar_enabled,
        sync_status=account.sync_status,
        last_synced_at=account.last_synced_at,
        last_error=account.last_error,
        skipped_events=len(account.skipped_event_ids or []),
    )


@router.post("/integrations/google/sync", status_code=202)
async def google_sync_now(
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> dict:
    settings = get_settings()
    _require_google(settings)
    account = await session.get(GoogleAccount, user.id)
    if account is None or not account.calendar_enabled:
        raise HTTPException(409, "Google Календарь не подключён")
    if account.sync_status in {"error", "reauth"}:
        account.sync_status = "idle"
        await session.commit()
    await schedule_google_sync(user.id, settings)
    return {"status": "queued"}


@router.delete("/integrations/google", status_code=204)
async def google_disconnect(
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Response:
    settings = get_settings()
    async with google_client(settings) as client:
        await disconnect_calendar(session, settings, user, client)
    await session.commit()
    return Response(status_code=204)
