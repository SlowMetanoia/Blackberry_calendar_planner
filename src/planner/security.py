import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import bcrypt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import get_settings
from .db import get_session
from .models import AuthSession, User

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, password_hash: str) -> bool:
    return bcrypt.checkpw(password.encode(), password_hash.encode())


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _aware_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


@dataclass(frozen=True)
class AuthSessionContext:
    user: User
    auth_session: AuthSession


async def create_auth_session(
    session: AsyncSession, user_id: uuid.UUID, *, now: datetime | None = None
) -> tuple[str, AuthSession]:
    current = now or datetime.now(UTC)
    settings = get_settings()
    await session.execute(
        delete(AuthSession).where(
            AuthSession.user_id == user_id,
            AuthSession.expires_at <= current,
        )
    )
    token = secrets.token_urlsafe(32)
    auth_session = AuthSession(
        user_id=user_id,
        token_hash=hash_token(token),
        last_seen_at=current,
        expires_at=current + timedelta(days=settings.auth_session_ttl_days),
    )
    session.add(auth_session)
    await session.flush()
    return token, auth_session


async def authenticate_session(
    token: str,
    session: AsyncSession,
    *,
    now: datetime | None = None,
) -> AuthSessionContext:
    current = now or datetime.now(UTC)
    row = (
        await session.execute(
            select(AuthSession, User)
            .join(User, User.id == AuthSession.user_id)
            .where(AuthSession.token_hash == hash_token(token))
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    auth_session, user = row
    if _aware_utc(auth_session.expires_at) <= current:
        await session.delete(auth_session)
        await session.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Expired token")
    settings = get_settings()
    renewal_interval = timedelta(hours=settings.auth_session_renew_interval_hours)
    if _aware_utc(auth_session.last_seen_at) <= current - renewal_interval:
        auth_session.last_seen_at = current
        auth_session.expires_at = current + timedelta(days=settings.auth_session_ttl_days)
        await session.commit()
    return AuthSessionContext(user=user, auth_session=auth_session)


async def current_auth_session(
    token: str = Depends(oauth2_scheme), session: AsyncSession = Depends(get_session)
) -> AuthSessionContext:
    return await authenticate_session(token, session)


async def current_user(
    context: AuthSessionContext = Depends(current_auth_session),
) -> User:
    return context.user
