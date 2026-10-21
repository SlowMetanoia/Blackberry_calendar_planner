"""Durable one-shot reminder scheduler and optional Web Push delivery."""

import json
import logging
from datetime import UTC, datetime, timedelta
from typing import Any, ClassVar

from arq.connections import RedisSettings
from arq.cron import cron
from sqlalchemy import select

from .config import get_settings
from .db import SessionLocal
from .models import Notification, NotificationDelivery, PushSubscription, Reminder
from .occurrences import aware_utc

logger = logging.getLogger(__name__)


async def process_due_reminders(ctx: dict[str, Any]) -> int:
    """Claim due reminders and create exactly one durable inbox record each."""
    now = datetime.now(UTC)
    claimed = 0
    async with SessionLocal() as session:
        reminders = list(
            (
                await session.scalars(
                    select(Reminder)
                    .where(Reminder.status == "active", Reminder.remind_at <= now)
                    .order_by(Reminder.remind_at, Reminder.id)
                    .limit(100)
                    .with_for_update(skip_locked=True)
                )
            ).all()
        )
        for reminder in reminders:
            reminder.status = "fired"
            reminder.fired_at = now
            notification = Notification(
                owner_id=reminder.owner_id,
                reminder_id=reminder.id,
                title=reminder.title,
                body=reminder.description,
            )
            session.add(notification)
            await session.flush()
            subscriptions = list(
                (
                    await session.scalars(
                        select(PushSubscription).where(
                            PushSubscription.owner_id == reminder.owner_id,
                            PushSubscription.active.is_(True),
                        )
                    )
                ).all()
            )
            session.add_all(
                [
                    NotificationDelivery(
                        notification_id=notification.id,
                        subscription_id=subscription.id,
                    )
                    for subscription in subscriptions
                ]
            )
            claimed += 1
        await session.commit()
    return claimed


async def _send_web_push(subscription: PushSubscription, notification: Notification) -> None:
    settings = get_settings()
    if not settings.web_push_vapid_private_key or not settings.web_push_vapid_subject:
        raise RuntimeError("Web Push VAPID is not configured")
    try:
        from pywebpush import webpush  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError("pywebpush is not installed") from exc
    from .schemas import PushSubscriptionPayload

    PushSubscriptionPayload(
        endpoint=subscription.endpoint, p256dh=subscription.p256dh, auth=subscription.auth
    )
    payload = json.dumps(
        {
            "notification_id": str(notification.id),
            "reminder_id": str(notification.reminder_id),
            "title": notification.title,
            "body": notification.body,
            "tag": f"reminder:{notification.reminder_id}",
        },
        ensure_ascii=False,
    )
    # pywebpush is synchronous; keep it out of the transaction and delegate to a thread.
    import asyncio

    await asyncio.to_thread(
        webpush,
        subscription_info={
            "endpoint": subscription.endpoint,
            "keys": {"p256dh": subscription.p256dh, "auth": subscription.auth},
        },
        data=payload,
        vapid_private_key=settings.web_push_vapid_private_key,
        vapid_claims={"sub": settings.web_push_vapid_subject},
        timeout=15,
        ttl=86400,
        content_encoding="aes128gcm",
    )


async def deliver_pending_notifications(ctx: dict[str, Any]) -> int:
    """Deliver due outbox rows; inbox records remain authoritative on every failure."""
    now = datetime.now(UTC)
    delivered = 0
    async with SessionLocal() as session:
        deliveries = list(
            (
                await session.scalars(
                    select(NotificationDelivery)
                    .where(
                        NotificationDelivery.status == "pending",
                        NotificationDelivery.next_attempt_at <= now,
                    )
                    .order_by(NotificationDelivery.next_attempt_at, NotificationDelivery.id)
                    .limit(100)
                    .with_for_update(skip_locked=True)
                )
            ).all()
        )
        for delivery in deliveries:
            notification = await session.get(Notification, delivery.notification_id)
            subscription = await session.get(PushSubscription, delivery.subscription_id)
            if notification is None or subscription is None or not subscription.active:
                delivery.status = "discarded"
                continue
            if aware_utc(notification.created_at) + timedelta(hours=24) <= now:
                delivery.status = "failed"
                delivery.last_error = "delivery_window_expired"
                continue
            try:
                await _send_web_push(subscription, notification)
            except Exception as exc:  # noqa: BLE001 - delivery is best effort; inbox is durable
                delivery.attempts += 1
                status = getattr(getattr(exc, "response", None), "status_code", None)
                delivery.last_error = f"http_{status}" if status else type(exc).__name__
                if status in {404, 410}:
                    subscription.active = False
                    delivery.status = "discarded"
                elif status and 400 <= status < 500 and status not in {408, 429}:
                    delivery.status = "failed"
                else:
                    delivery.next_attempt_at = now + timedelta(
                        minutes=min(60, 2 ** min(delivery.attempts, 6))
                    )
                logger.warning(
                    "Web Push delivery failed id=%s kind=%s", delivery.id, delivery.last_error
                )
                continue
            delivery.status = "sent"
            delivery.attempts += 1
            delivered += 1
        await session.commit()
    return delivered


class NotifierSettings:
    functions: ClassVar[list] = [process_due_reminders, deliver_pending_notifications]
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
    queue_name = "calendar-notifications"
    max_jobs = 4
    cron_jobs: ClassVar[list] = [
        cron(
            process_due_reminders,
            second={0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55},
            run_at_startup=True,
        ),
        cron(deliver_pending_notifications, second={1, 6, 11, 16, 21, 26, 31, 36, 41, 46, 51, 56}),
    ]


async def startup(ctx: dict[str, Any]) -> None:
    await process_due_reminders(ctx)
    await deliver_pending_notifications(ctx)
