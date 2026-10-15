from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from planner.db import Base
from planner.models import AuthSession, User
from planner.security import (
    authenticate_session,
    create_auth_session,
    hash_password,
    hash_token,
    verify_password,
)


@pytest.fixture
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as value:
        yield value
    await engine.dispose()


@pytest.fixture
async def user(session):
    value = User(email="security@example.test", password_hash="hash")
    session.add(value)
    await session.commit()
    return value


def test_password_hash_round_trip() -> None:
    password = "correct horse battery staple"
    hashed = hash_password(password)
    assert hashed != password
    assert verify_password(password, hashed)
    assert not verify_password("wrong password", hashed)


async def test_session_stores_only_token_hash(session, user) -> None:
    token, created = await create_auth_session(session, user.id)
    await session.commit()

    stored = await session.scalar(select(AuthSession).where(AuthSession.id == created.id))
    assert stored is not None
    assert stored.token_hash == hash_token(token)
    assert token != stored.token_hash
    assert len(stored.token_hash) == 64
    assert (await authenticate_session(token, session)).user.id == user.id


async def test_unknown_and_expired_sessions_are_rejected(session, user) -> None:
    now = datetime(2026, 10, 15, tzinfo=UTC)
    token, _ = await create_auth_session(session, user.id, now=now)
    await session.commit()

    with pytest.raises(HTTPException) as unknown:
        await authenticate_session("unknown", session, now=now)
    assert unknown.value.status_code == 401

    with pytest.raises(HTTPException) as expired:
        await authenticate_session(token, session, now=now + timedelta(days=8))
    assert expired.value.status_code == 401
    assert (
        await session.scalar(select(AuthSession).where(AuthSession.token_hash == hash_token(token)))
        is None
    )


async def test_active_session_renews_at_most_once_per_day(session, user) -> None:
    now = datetime(2026, 10, 15, tzinfo=UTC)
    token, created = await create_auth_session(session, user.id, now=now)
    await session.commit()
    original_expiry = created.expires_at

    await authenticate_session(token, session, now=now + timedelta(hours=23))
    assert created.expires_at == original_expiry

    await authenticate_session(token, session, now=now + timedelta(hours=25))
    assert created.last_seen_at == now + timedelta(hours=25)
    assert created.expires_at == now + timedelta(days=8, hours=1)


async def test_multiple_sessions_for_one_user_remain_independent(session, user) -> None:
    first, first_row = await create_auth_session(session, user.id)
    second, _ = await create_auth_session(session, user.id)
    await session.commit()

    await session.delete(first_row)
    await session.commit()

    with pytest.raises(HTTPException):
        await authenticate_session(first, session)
    assert (await authenticate_session(second, session)).user.id == user.id
