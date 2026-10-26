"""Linking Google identities to planner users and managing calendar access."""

import logging

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import Settings
from .google_client import GoogleClient, GoogleIdentity, GoogleTokens, decrypt_token, encrypt_token
from .models import GoogleAccount, GoogleEventLink, User

logger = logging.getLogger(__name__)


class GoogleLinkError(Exception):
    """A Google sign-in or connection cannot be completed; ``code`` is shown to the UI."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


async def sign_in_with_google(session: AsyncSession, identity: GoogleIdentity) -> User:
    """Return the user for a Google identity, linking or registering by verified email."""
    account = await session.scalar(
        select(GoogleAccount).where(GoogleAccount.subject == identity.subject)
    )
    if account is not None:
        return await session.get(User, account.user_id)
    if not identity.email or not identity.email_verified:
        raise GoogleLinkError("email_unverified")
    user = await session.scalar(select(User).where(func.lower(User.email) == identity.email))
    if user is None:
        # Google-only users have no password; an empty hash never verifies.
        user = User(email=identity.email, password_hash="")
        session.add(user)
        await session.flush()
    elif await session.get(GoogleAccount, user.id) is not None:
        raise GoogleLinkError("linked_elsewhere")
    session.add(GoogleAccount(user_id=user.id, subject=identity.subject, email=identity.email))
    await session.flush()
    return user


async def connect_calendar(
    session: AsyncSession,
    settings: Settings,
    user: User,
    identity: GoogleIdentity,
    tokens: GoogleTokens,
) -> GoogleAccount:
    owner = await session.scalar(
        select(GoogleAccount).where(GoogleAccount.subject == identity.subject)
    )
    if owner is not None and owner.user_id != user.id:
        raise GoogleLinkError("linked_elsewhere")
    if not tokens.has_calendar or not tokens.refresh_token:
        raise GoogleLinkError("calendar_scope")
    account = await session.get(GoogleAccount, user.id)
    if account is None:
        account = GoogleAccount(user_id=user.id, subject=identity.subject, email=identity.email)
        session.add(account)
    elif account.subject != identity.subject:
        # Links point at another Google calendar and cannot be reused.
        await session.execute(delete(GoogleEventLink).where(GoogleEventLink.owner_id == user.id))
        account.subject = identity.subject
    account.email = identity.email
    account.refresh_token_encrypted = encrypt_token(settings, tokens.refresh_token)
    account.calendar_enabled = True
    account.calendar_id = "primary"
    account.sync_token = None
    account.pushed_sequence = 0
    account.sync_status = "idle"
    account.last_error = None
    account.skipped_event_ids = []
    await session.flush()
    return account


async def disconnect_calendar(
    session: AsyncSession, settings: Settings, user: User, client: GoogleClient
) -> None:
    """Stop syncing; events stay in both calendars and links are kept for a reconnect."""
    account = await session.get(GoogleAccount, user.id)
    if account is None:
        return
    if account.refresh_token_encrypted:
        try:
            await client.revoke(decrypt_token(settings, account.refresh_token_encrypted))
        except Exception:  # noqa: BLE001 - revocation is best effort
            logger.warning("Google token revocation failed for %s", user.id)
    account.refresh_token_encrypted = None
    account.calendar_enabled = False
    account.sync_token = None
    account.sync_status = "idle"
    account.last_error = None
    await session.flush()
