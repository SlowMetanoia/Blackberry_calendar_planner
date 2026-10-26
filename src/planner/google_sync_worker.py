"""ARQ worker that keeps linked Google calendars in sync."""

import logging
import uuid
from datetime import UTC, datetime
from typing import Any, ClassVar

import httpx
from arq import create_pool
from arq.connections import RedisSettings
from arq.cron import cron
from sqlalchemy import select

from .config import Settings, get_settings
from .db import SessionLocal
from .google_client import (
    GoogleApiError,
    GoogleClient,
    GoogleReauthRequired,
    TokenCipherError,
    decrypt_token,
)
from .google_sync import GoogleCalendarSync
from .models import GoogleAccount, User

logger = logging.getLogger(__name__)
QUEUE_NAME = "google-sync"
LOCK_TTL_MS = 600_000
RELEASE_LOCK_SCRIPT = """
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
"""


def _lock_key(owner_id: str) -> str:
    return f"google-sync:{owner_id}"


def _pending_key(owner_id: str) -> str:
    return f"google-sync-pending:{owner_id}"


async def schedule_google_sync(owner_id: uuid.UUID, settings: Settings) -> None:
    """Ask the sync worker to push and pull this owner's calendar soon."""
    if not settings.google_enabled:
        return
    try:
        pool = await create_pool(RedisSettings.from_dsn(settings.redis_url))
        try:
            await pool.enqueue_job("sync_google_calendar", str(owner_id), _queue_name=QUEUE_NAME)
        finally:
            await pool.close()
    except Exception:  # noqa: BLE001 - the periodic sweep repairs a missed nudge
        logger.warning("Google sync enqueue failed for owner %s", owner_id)


def describe_sync_error(exc: Exception) -> str:
    """Return a message the calendar owner can act on; details stay in the worker log."""
    if isinstance(exc, GoogleApiError):
        text = str(exc).lower()
        if exc.status_code == 403 and ("has not been used" in text or "disabled" in text):
            return (
                "В проекте Google Cloud не включён Google Calendar API. "
                "Включите его в консоли Google Cloud и повторите синхронизацию."
            )
        if exc.status_code == 403 and "insufficient" in text:
            return (
                "Google не дал доступ к календарю. "
                "Подключите календарь заново и разрешите доступ к нему."
            )
        if exc.status_code == 429 or exc.status_code >= 500:
            return "Google временно недоступен или ограничил число запросов. Повторим позже."
        return f"Google вернул ошибку {exc.status_code}."
    if isinstance(exc, httpx.HTTPError):
        return "Не удалось связаться с Google. Повторим позже."
    return "Внутренняя ошибка синхронизации. Подробности в журнале сервиса calendar-sync."


async def _sync_once(owner_id: uuid.UUID, settings: Settings) -> None:
    async with SessionLocal() as session:
        account = await session.get(GoogleAccount, owner_id)
        user = await session.get(User, owner_id)
        if account is None or user is None or not account.calendar_enabled:
            return
        if not account.refresh_token_encrypted:
            return
        account.sync_status = "syncing"
        await session.commit()
        try:
            async with GoogleClient(settings) as client:
                access_token = await client.refresh_access_token(
                    decrypt_token(settings, account.refresh_token_encrypted)
                )
                result = await GoogleCalendarSync(
                    session, user, account, client, settings, access_token
                ).run()
            account.sync_status = "ok"
            account.last_error = None
            account.last_synced_at = datetime.now(UTC)
            await session.commit()
            logger.info("Google sync for %s finished: %s", owner_id, result)
        except (GoogleReauthRequired, TokenCipherError) as exc:
            await session.rollback()
            await _mark_failed(owner_id, "reauth", str(exc))
        except Exception as exc:
            await session.rollback()
            logger.exception("Google sync failed for owner %s", owner_id)
            await _mark_failed(owner_id, "error", describe_sync_error(exc))
            raise


async def _mark_failed(owner_id: uuid.UUID, status: str, message: str) -> None:
    async with SessionLocal() as session:
        account = await session.get(GoogleAccount, owner_id)
        if account is not None:
            account.sync_status = status
            account.last_error = message[:500]
            await session.commit()


async def sync_google_calendar(ctx: dict[str, Any], owner_id: str) -> None:
    settings = get_settings()
    redis = ctx["redis"]
    token = str(uuid.uuid4())
    if not await redis.set(_lock_key(owner_id), token, nx=True, px=LOCK_TTL_MS):
        # A sync is running; make it repeat once so this change is not missed.
        await redis.set(_pending_key(owner_id), "1", px=LOCK_TTL_MS)
        return
    try:
        while True:
            await redis.delete(_pending_key(owner_id))
            await _sync_once(uuid.UUID(owner_id), settings)
            if not await redis.exists(_pending_key(owner_id)):
                return
    finally:
        await redis.eval(RELEASE_LOCK_SCRIPT, 1, _lock_key(owner_id), token)


async def enqueue_due_google_syncs(ctx: dict[str, Any]) -> int:
    """Periodic pull: Google push notifications need a public HTTPS endpoint."""
    async with SessionLocal() as session:
        owners = list(
            (
                await session.scalars(
                    select(GoogleAccount.user_id).where(
                        GoogleAccount.calendar_enabled.is_(True),
                        GoogleAccount.sync_status != "reauth",
                    )
                )
            ).all()
        )
    for owner_id in owners:
        await ctx["redis"].enqueue_job(
            "sync_google_calendar", str(owner_id), _queue_name=QUEUE_NAME
        )
    return len(owners)


class GoogleSyncWorkerSettings:
    functions: ClassVar[list] = [sync_google_calendar]
    cron_jobs: ClassVar[list] = [cron(enqueue_due_google_syncs, second=0, run_at_startup=True)]
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
    queue_name = QUEUE_NAME
    max_jobs = 4
    max_tries = 3
    job_timeout = 600
