"""Thin httpx client for Google OAuth 2.0 and the Calendar v3 events API."""

import base64
import hashlib
from dataclasses import dataclass
from typing import Any, Self
from urllib.parse import quote, urlencode

import httpx
from cryptography.fernet import Fernet, InvalidToken

from .config import Settings

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
CALENDAR_URL = "https://www.googleapis.com/calendar/v3"
IDENTITY_SCOPES = ("openid", "email", "profile")
CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events"


class GoogleApiError(RuntimeError):
    def __init__(self, status_code: int, message: str):
        super().__init__(f"Google API {status_code}: {message}")
        self.status_code = status_code


class GoogleReauthRequired(GoogleApiError):
    """The refresh token was revoked or expired; the user must reconnect."""


class GoogleSyncTokenExpired(GoogleApiError):
    """The incremental sync token is no longer valid; a full sync is required."""


class GoogleEventMissing(GoogleApiError):
    """The target Google event no longer exists."""


class TokenCipherError(RuntimeError):
    pass


def _fernet(settings: Settings) -> Fernet:
    if not settings.calendar_token_key:
        raise TokenCipherError("CALENDAR_TOKEN_KEY is not configured")
    digest = hashlib.sha256(settings.calendar_token_key.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_token(settings: Settings, token: str) -> str:
    return _fernet(settings).encrypt(token.encode()).decode()


def decrypt_token(settings: Settings, value: str) -> str:
    try:
        return _fernet(settings).decrypt(value.encode()).decode()
    except InvalidToken as exc:
        raise TokenCipherError("stored Google token cannot be decrypted") from exc


@dataclass(frozen=True)
class GoogleTokens:
    access_token: str
    refresh_token: str | None
    scope: str

    @property
    def has_calendar(self) -> bool:
        return CALENDAR_SCOPE in self.scope.split()


@dataclass(frozen=True)
class GoogleIdentity:
    subject: str
    email: str
    email_verified: bool


def authorization_url(settings: Settings, state: str, *, calendar: bool) -> str:
    scopes = [*IDENTITY_SCOPES, *([CALENDAR_SCOPE] if calendar else [])]
    params = {
        "client_id": settings.google_calendar_client_id,
        "redirect_uri": settings.google_redirect_url,
        "response_type": "code",
        "scope": " ".join(scopes),
        "state": state,
        "include_granted_scopes": "true",
    }
    if calendar:
        # A refresh token is only issued with offline access and an explicit consent.
        params.update(access_type="offline", prompt="consent")
    else:
        params["prompt"] = "select_account"
    return f"{AUTH_URL}?{urlencode(params)}"


class GoogleClient:
    def __init__(self, settings: Settings, http: httpx.AsyncClient | None = None):
        self.settings = settings
        self._http = http

    async def __aenter__(self) -> Self:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=self.settings.calendar_http_timeout_seconds)
            self._owned = True
        else:
            self._owned = False
        return self

    async def __aexit__(self, *_args) -> None:
        if self._owned and self._http is not None:
            await self._http.aclose()
            self._http = None

    @property
    def http(self) -> httpx.AsyncClient:
        if self._http is None:
            raise RuntimeError("GoogleClient must be used as an async context manager")
        return self._http

    @staticmethod
    def _raise_for(response: httpx.Response) -> None:
        if response.is_success:
            return
        try:
            body = response.json()
        except ValueError:
            body = {}
        error = body.get("error")
        message = (
            error.get("message") if isinstance(error, dict) else body.get("error_description")
        ) or str(error or response.reason_phrase)
        if response.status_code == 400 and error == "invalid_grant":
            raise GoogleReauthRequired(response.status_code, message)
        raise GoogleApiError(response.status_code, message)

    async def exchange_code(self, code: str) -> GoogleTokens:
        response = await self.http.post(
            TOKEN_URL,
            data={
                "code": code,
                "client_id": self.settings.google_calendar_client_id,
                "client_secret": self.settings.google_calendar_client_secret,
                "redirect_uri": self.settings.google_redirect_url,
                "grant_type": "authorization_code",
            },
        )
        self._raise_for(response)
        body = response.json()
        return GoogleTokens(body["access_token"], body.get("refresh_token"), body.get("scope", ""))

    async def refresh_access_token(self, refresh_token: str) -> str:
        response = await self.http.post(
            TOKEN_URL,
            data={
                "refresh_token": refresh_token,
                "client_id": self.settings.google_calendar_client_id,
                "client_secret": self.settings.google_calendar_client_secret,
                "grant_type": "refresh_token",
            },
        )
        self._raise_for(response)
        return response.json()["access_token"]

    async def revoke(self, token: str) -> None:
        try:
            await self.http.post(REVOKE_URL, data={"token": token})
        except httpx.HTTPError:
            pass

    async def identity(self, access_token: str) -> GoogleIdentity:
        response = await self.http.get(
            USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"}
        )
        self._raise_for(response)
        body = response.json()
        return GoogleIdentity(
            subject=str(body["sub"]),
            email=str(body.get("email", "")).lower(),
            email_verified=bool(body.get("email_verified")),
        )

    def _events_url(self, calendar_id: str, event_id: str | None = None) -> str:
        url = f"{CALENDAR_URL}/calendars/{quote(calendar_id, safe='')}/events"
        return f"{url}/{quote(event_id, safe='')}" if event_id else url

    async def _calendar(
        self,
        method: str,
        access_token: str,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
    ) -> httpx.Response:
        response = await self.http.request(
            method,
            url,
            params=params,
            json=json,
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if response.status_code == 401:
            raise GoogleReauthRequired(401, "access token rejected")
        return response

    async def list_events(
        self,
        access_token: str,
        calendar_id: str,
        *,
        sync_token: str | None = None,
        time_min: str | None = None,
        page_token: str | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "maxResults": 2500,
            "singleEvents": "false",
            "showDeleted": "true",
        }
        if sync_token:
            params["syncToken"] = sync_token
        elif time_min:
            params["timeMin"] = time_min
        if page_token:
            params["pageToken"] = page_token
        response = await self._calendar(
            "GET", access_token, self._events_url(calendar_id), params=params
        )
        if response.status_code == 410:
            raise GoogleSyncTokenExpired(410, "sync token expired")
        self._raise_for(response)
        return response.json()

    async def insert_event(
        self, access_token: str, calendar_id: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        response = await self._calendar(
            "POST", access_token, self._events_url(calendar_id), json=body
        )
        self._raise_for(response)
        return response.json()

    async def update_event(
        self, access_token: str, calendar_id: str, event_id: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        # PATCH keeps what the planner does not model: attendees, Meet links, colors.
        response = await self._calendar(
            "PATCH", access_token, self._events_url(calendar_id, event_id), json=body
        )
        if response.status_code in {404, 410}:
            raise GoogleEventMissing(response.status_code, event_id)
        self._raise_for(response)
        return response.json()

    async def delete_event(self, access_token: str, calendar_id: str, event_id: str) -> None:
        response = await self._calendar(
            "DELETE", access_token, self._events_url(calendar_id, event_id)
        )
        if response.status_code in {404, 410}:
            return
        self._raise_for(response)
