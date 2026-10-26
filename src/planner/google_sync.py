"""Two-way synchronization between planner events and a Google calendar.

Each non-empty planner schedule version maps to one Google event (a recurring master
or a single event); changed or cancelled occurrences map to Google instance overrides.
Inbound changes are applied through ``CalendarCommandService`` with origin ``google``
so they land in the immutable history. Outbound changes are found by walking the
operation log past ``GoogleAccount.pushed_sequence`` and pushing the current state of
every touched series. Concurrent edits resolve as last-writer-wins.
"""

import hashlib
import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .calendar import CalendarCommandService, CalendarMutation, CalendarValidationError
from .config import Settings
from .google_client import (
    GoogleApiError,
    GoogleClient,
    GoogleEventMissing,
    GoogleReauthRequired,
    GoogleSyncTokenExpired,
)
from .google_mapping import (
    UnsupportedGoogleEvent,
    can_be_all_day,
    event_from_google,
    exdates_from_recurrence,
    google_time_range,
    instance_id,
    original_start,
    rrule_from_recurrence,
)
from .models import (
    CalendarOccurrenceException,
    CalendarOperation,
    CalendarScheduleVersion,
    Event,
    GoogleAccount,
    GoogleEventLink,
    Reminder,
    User,
)
from .occurrences import OccurrenceService, aware_utc, occurrence_key
from .recurrence import expand_recurrence

logger = logging.getLogger(__name__)
FAR_FUTURE = timedelta(days=366 * 100)
TEXT_FIELDS = ("title", "description", "location", "duration_minutes")
# Fields Google accepts in an update of restricted event types (see the event types guide).
RESTRICTED_FIELDS = {"birthday": {"summary", "reminders"}, "fromGmail": {"reminders"}}
MAX_NOTIFICATION_MINUTES = 40_320  # Google allows notifications up to four weeks ahead.
MAX_NOTIFICATIONS = 5


@dataclass
class SyncResult:
    imported: int = 0
    updated: int = 0
    deleted: int = 0
    pushed: int = 0
    skipped: int = 0
    skipped_ids: list[str] = field(default_factory=list)


def content_hash(body: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(body, sort_keys=True, ensure_ascii=False, default=str).encode()
    ).hexdigest()


def _same(left: Any, right: Any) -> bool:
    if isinstance(left, datetime) and isinstance(right, datetime):
        return aware_utc(left) == aware_utc(right)
    if isinstance(left, str) and isinstance(right, datetime):
        try:
            return aware_utc(datetime.fromisoformat(left)) == aware_utc(right)
        except ValueError:
            return False
    return left == right


def version_is_empty(version: CalendarScheduleVersion) -> bool:
    upper = aware_utc(version.active_until) if version.active_until else None
    lower = aware_utc(version.active_from)
    anchor = aware_utc(version.anchor_at)
    return not expand_recurrence(
        anchor,
        version.recurrence,
        version.timezone,
        lower,
        upper or anchor + FAR_FUTURE,
        limit=1,
    )


def first_occurrence(version: CalendarScheduleVersion) -> datetime | None:
    anchor = aware_utc(version.anchor_at)
    found = expand_recurrence(
        anchor,
        version.recurrence,
        version.timezone,
        aware_utc(version.active_from),
        aware_utc(version.active_until) if version.active_until else anchor + FAR_FUTURE,
        limit=1,
    )
    return found[0] if found else None


def master_body(
    event: Event,
    version: CalendarScheduleVersion,
    *,
    all_day: bool,
    event_type: str = "default",
    reminders: dict[str, Any] | None = None,
) -> dict:
    anchor = aware_utc(version.anchor_at)
    start, end = google_time_range(
        anchor, event.duration_minutes, version.timezone, all_day=all_day
    )
    recurrence = []
    if version.recurrence is not None:
        recurrence.append(
            rrule_from_recurrence(
                version.recurrence,
                anchor,
                version.timezone,
                active_until=aware_utc(version.active_until) if version.active_until else None,
                all_day=all_day,
            )
        )
    body = {
        "summary": event.title,
        "description": event.description or "",
        "location": event.location or "",
        "start": start,
        "end": end,
        "recurrence": recurrence,
        "extendedProperties": {
            "private": {
                "planner_series_id": str(event.id),
                "planner_version_id": str(version.id),
            }
        },
    }
    if reminders is not None:
        body["reminders"] = reminders
    allowed = RESTRICTED_FIELDS.get(event_type)
    if allowed is not None:
        body = {key: value for key, value in body.items() if key in allowed}
    return body


def is_permanent_rejection(exc: GoogleApiError) -> bool:
    """Google refused this particular change; retrying the same request cannot succeed."""
    if isinstance(exc, (GoogleReauthRequired, GoogleSyncTokenExpired)):
        return False
    text = str(exc).lower()
    transient = ("rate limit", "ratelimit", "quota", "has not been used", "disabled")
    return exc.status_code in {400, 403} and not any(word in text for word in transient)


def instance_body(
    data: dict[str, Any],
    master_id: str,
    original_at: datetime,
    timezone: str,
    *,
    all_day: bool,
) -> dict:
    starts_at = data["starts_at"]
    if isinstance(starts_at, str):
        starts_at = datetime.fromisoformat(starts_at)
    start, end = google_time_range(
        aware_utc(starts_at), data.get("duration_minutes"), timezone, all_day=all_day
    )
    original, _ = google_time_range(original_at, None, timezone, all_day=all_day)
    return {
        "summary": data.get("title") or "",
        "description": data.get("description") or "",
        "location": data.get("location") or "",
        "start": start,
        "end": end,
        "status": "confirmed",
        "recurringEventId": master_id,
        "originalStartTime": original,
    }


def _parse_updated(item: dict[str, Any]) -> datetime | None:
    value = item.get("updated")
    if not value:
        return None
    try:
        return aware_utc(datetime.fromisoformat(value))
    except ValueError:
        return None


class GoogleCalendarSync:
    def __init__(
        self,
        session: AsyncSession,
        user: User,
        account: GoogleAccount,
        client: GoogleClient,
        settings: Settings,
        access_token: str,
        *,
        now: datetime | None = None,
    ):
        self.session = session
        self.user = user
        self.account = account
        self.client = client
        self.settings = settings
        self.access_token = access_token
        self.now = now or datetime.now(UTC)
        self.result = SyncResult()
        self._dirty: dict[uuid.UUID, datetime] = {}
        self._skipped_ids: set[str] = set(account.skipped_event_ids or [])

    async def run(self) -> SyncResult:
        # Commit between steps: Google writes cannot be rolled back, so the links that
        # record them must persist even if a later step fails.
        await self.pull()
        await self.session.commit()
        await self.push()
        await self.session.commit()
        return self.result

    # -- shared helpers ---------------------------------------------------------------

    async def _execute(self, mutations: list[CalendarMutation]):
        return await CalendarCommandService.execute(
            self.session, self.user, mutations, origin="google"
        )

    async def _event(self, series_id: uuid.UUID) -> Event | None:
        return await self.session.scalar(
            select(Event).where(Event.id == series_id, Event.owner_id == self.user.id)
        )

    async def _link_by_google_id(self, google_event_id: str) -> GoogleEventLink | None:
        return await self.session.scalar(
            select(GoogleEventLink).where(
                GoogleEventLink.owner_id == self.user.id,
                GoogleEventLink.google_event_id == google_event_id,
            )
        )

    async def _link(
        self, series_id: uuid.UUID, version_id: uuid.UUID, key: str = ""
    ) -> GoogleEventLink | None:
        return await self.session.scalar(
            select(GoogleEventLink).where(
                GoogleEventLink.owner_id == self.user.id,
                GoogleEventLink.series_id == series_id,
                GoogleEventLink.version_id == version_id,
                GoogleEventLink.occurrence_key == key,
            )
        )

    async def _drop_version_links(self, series_id: uuid.UUID, version_id: uuid.UUID) -> None:
        await self.session.execute(
            delete(GoogleEventLink).where(
                GoogleEventLink.owner_id == self.user.id,
                GoogleEventLink.series_id == series_id,
                GoogleEventLink.version_id == version_id,
            )
        )

    def _skip(self, item: dict[str, Any], reason: str) -> None:
        self.result.skipped += 1
        self.result.skipped_ids.append(str(item.get("id")))
        if not item.get("recurringEventId"):
            self._skipped_ids.add(str(item.get("id")))
        logger.info("Skipping Google event %s for %s: %s", item.get("id"), self.user.id, reason)

    def _locally_newer(self, series_id: uuid.UUID, item: dict[str, Any]) -> bool:
        local = self._dirty.get(series_id)
        remote = _parse_updated(item)
        return local is not None and (remote is None or remote <= local)

    async def _load_dirty_series(self) -> None:
        rows = await self.session.execute(
            select(CalendarOperation.target_id, func.max(CalendarOperation.created_at))
            .where(
                CalendarOperation.owner_id == self.user.id,
                CalendarOperation.sequence > self.account.pushed_sequence,
                CalendarOperation.resource == "event",
                CalendarOperation.origin != "google",
            )
            .group_by(CalendarOperation.target_id)
        )
        self._dirty = {target: aware_utc(created) for target, created in rows.all() if created}

    # -- inbound ----------------------------------------------------------------------

    async def _list_changes(self) -> tuple[list[dict[str, Any]], str | None]:
        while True:
            items: list[dict[str, Any]] = []
            page_token = None
            full = self.account.sync_token is None
            time_min = (
                (self.now - timedelta(days=self.settings.calendar_sync_past_days))
                .isoformat()
                .replace("+00:00", "Z")
            )
            try:
                while True:
                    page = await self.client.list_events(
                        self.access_token,
                        self.account.calendar_id,
                        sync_token=self.account.sync_token,
                        time_min=time_min if full else None,
                        page_token=page_token,
                    )
                    items.extend(page.get("items") or [])
                    page_token = page.get("nextPageToken")
                    if not page_token:
                        return items, page.get("nextSyncToken")
            except GoogleSyncTokenExpired:
                if full:
                    raise
                self.account.sync_token = None

    async def pull(self) -> None:
        await self._load_dirty_series()
        full = self.account.sync_token is None
        items, next_sync_token = await self._list_changes()
        if full or self.account.sync_token is None:
            self._skipped_ids.clear()
        masters = [item for item in items if not item.get("recurringEventId")]
        instances = [item for item in items if item.get("recurringEventId")]
        for item in masters:
            # Every change to a master is re-evaluated; it is re-added if still unsupported.
            self._skipped_ids.discard(str(item.get("id")))
            await self._guarded(self._apply_master, item)
        for item in instances:
            await self._guarded(self._apply_instance, item)
        self.account.sync_token = next_sync_token
        self.account.skipped_event_ids = sorted(self._skipped_ids)
        await self.session.flush()

    async def _guarded(self, handler, item: dict[str, Any]) -> None:
        try:
            await handler(item)
        except (UnsupportedGoogleEvent, CalendarValidationError) as exc:
            self._skip(item, str(exc))

    async def _adopt(self, item: dict[str, Any]) -> GoogleEventLink | None:
        """Re-link an event this planner pushed earlier (for example after a reconnect)."""
        private = (item.get("extendedProperties") or {}).get("private") or {}
        try:
            series_id = uuid.UUID(private["planner_series_id"])
            version_id = uuid.UUID(private["planner_version_id"])
        except (KeyError, TypeError, ValueError):
            return None
        version = await self.session.get(CalendarScheduleVersion, version_id)
        if (
            version is None
            or version.owner_id != self.user.id
            or version.series_id != series_id
            or await self._event(series_id) is None
        ):
            return None
        link = await self._link(series_id, version_id)
        if link is None:
            link = GoogleEventLink(
                owner_id=self.user.id,
                series_id=series_id,
                version_id=version_id,
                google_event_id=item["id"],
            )
            self.session.add(link)
        else:
            link.google_event_id = item["id"]
        await self.session.flush()
        return link

    async def _apply_master(self, item: dict[str, Any]) -> None:
        link = await self._link_by_google_id(item["id"]) or await self._adopt(item)
        if item.get("status") == "cancelled":
            if link is not None:
                await self._apply_master_deletion(link, item)
            return
        if link is not None:
            link.event_type = item.get("eventType") or "default"
        if link is not None and link.etag and link.etag == item.get("etag"):
            return
        fields = event_from_google(item, default_timezone=self.user.timezone)
        if link is None:
            await self._import_master(item, fields)
            return
        event = await self._event(link.series_id)
        version = await self.session.get(CalendarScheduleVersion, link.version_id)
        if event is None or version is None or self._locally_newer(link.series_id, item):
            # A pending local edit (or deletion) is newer and will be pushed instead.
            return
        payload: dict[str, Any] = {
            key: value
            for key, value in fields.payload().items()
            if key in TEXT_FIELDS and not _same(getattr(event, key), value)
        }
        effective_from = None
        schedule_changed = False
        if version.id == event.recurrence_version_id:
            schedule_changed = (
                not _same(aware_utc(version.anchor_at), fields.starts_at)
                or version.recurrence != fields.recurrence
                or (
                    fields.recurrence is not None and version.timezone != fields.recurrence_timezone
                )
            )
        if schedule_changed:
            payload.update(
                starts_at=fields.starts_at,
                recurrence=fields.recurrence,
                recurrence_timezone=fields.recurrence_timezone,
            )
            first = first_occurrence(version) if version.recurrence is not None else None
            if first is not None:
                # Google edits "all events" from the series start: replace the whole linked
                # version instead of splitting it at "now". The boundary also covers a start
                # moved earlier, so undo still removes the replacement version.
                effective_from = occurrence_key(version.id, min(first, fields.starts_at))
        if payload:
            await CalendarCommandService.execute(
                self.session,
                self.user,
                [
                    CalendarMutation(
                        "update",
                        "event",
                        payload,
                        event.id,
                        effective_from_occurrence_key=effective_from,
                    )
                ],
                origin="google",
            )
            self.result.updated += 1
            await self.session.refresh(event)
            if event.recurrence_version_id and event.recurrence_version_id != version.id:
                await self.session.execute(
                    delete(GoogleEventLink).where(
                        GoogleEventLink.owner_id == self.user.id,
                        GoogleEventLink.series_id == event.id,
                        GoogleEventLink.version_id == version.id,
                        GoogleEventLink.occurrence_key != "",
                    )
                )
                link.version_id = event.recurrence_version_id
                version = await self.session.get(CalendarScheduleVersion, link.version_id)
        link.etag = item.get("etag")
        link.all_day = fields.all_day
        await self._apply_exdates(event, version, item)
        link.content_hash = content_hash(await self._master_body(event, version, link))
        await self.session.flush()

    async def _import_master(self, item: dict[str, Any], fields) -> None:
        operation = (await self._execute([CalendarMutation("create", "event", fields.payload())]))[
            0
        ]
        event = await self._event(operation.target_id)
        version = await self.session.get(CalendarScheduleVersion, event.recurrence_version_id)
        link = GoogleEventLink(
            owner_id=self.user.id,
            series_id=event.id,
            version_id=version.id,
            google_event_id=item["id"],
            etag=item.get("etag"),
            all_day=fields.all_day,
            event_type=item.get("eventType") or "default",
        )
        self.session.add(link)
        await self.session.flush()
        await self._apply_exdates(event, version, item)
        link.content_hash = content_hash(await self._master_body(event, version, link))
        self.result.imported += 1
        await self.session.flush()

    async def _apply_master_deletion(self, link: GoogleEventLink, item: dict[str, Any]) -> None:
        event = await self._event(link.series_id)
        if event is not None and not self._locally_newer(link.series_id, item):
            versions = await OccurrenceService._series_versions(
                self.session, self.user, "event", event.id
            )
            live = [version for version in versions if not version_is_empty(version)]
            if link.version_id == event.recurrence_version_id or len(live) <= 1:
                await self._execute([CalendarMutation("delete", "event", {}, event.id)])
                self.result.deleted += 1
        await self._drop_version_links(link.series_id, link.version_id)
        await self.session.flush()

    async def _apply_exdates(
        self, event: Event, version: CalendarScheduleVersion, item: dict[str, Any]
    ) -> None:
        for moment in exdates_from_recurrence(item.get("recurrence") or [], version.timezone):
            key = occurrence_key(version.id, moment)
            await self._cancel_occurrence(event.id, key)

    async def _cancel_occurrence(self, series_id: uuid.UUID, key: str) -> bool:
        occurrence = await OccurrenceService.get(self.session, self.user, "event", series_id, key)
        if occurrence is None:
            return False
        exception = await self.session.scalar(
            select(CalendarOccurrenceException).where(
                CalendarOccurrenceException.owner_id == self.user.id,
                CalendarOccurrenceException.resource == "event",
                CalendarOccurrenceException.series_id == series_id,
                CalendarOccurrenceException.occurrence_key == key,
            )
        )
        if exception is not None and exception.cancelled:
            return False
        await self._execute(
            [
                CalendarMutation(
                    "delete", "event", {}, series_id, scope="occurrence", occurrence_key=key
                )
            ]
        )
        return True

    async def _apply_instance(self, item: dict[str, Any]) -> None:
        master = await self._link_by_google_id(item["recurringEventId"])
        if master is None or master.occurrence_key:
            return
        event = await self._event(master.series_id)
        version = await self.session.get(CalendarScheduleVersion, master.version_id)
        if event is None or version is None or self._locally_newer(event.id, item):
            return
        original = original_start(item, version.timezone)
        key = occurrence_key(version.id, original)
        link = await self._link_by_google_id(item["id"])
        if link is not None and link.etag and link.etag == item.get("etag"):
            return
        if item.get("status") == "cancelled":
            if await self._cancel_occurrence(event.id, key):
                self.result.deleted += 1
        else:
            occurrence = await OccurrenceService.get(
                self.session, self.user, "event", event.id, key
            )
            if occurrence is None:
                raise UnsupportedGoogleEvent("instance does not match the planner series")
            fields = event_from_google(
                {**item, "recurrence": None}, default_timezone=version.timezone
            )
            desired = {
                "title": fields.title,
                "description": fields.description,
                "location": fields.location,
                "starts_at": fields.starts_at,
                "duration_minutes": fields.duration_minutes,
            }
            payload = {
                key_: value
                for key_, value in desired.items()
                if not _same(occurrence.data.get(key_), value)
            }
            exception = await self.session.scalar(
                select(CalendarOccurrenceException).where(
                    CalendarOccurrenceException.owner_id == self.user.id,
                    CalendarOccurrenceException.resource == "event",
                    CalendarOccurrenceException.series_id == event.id,
                    CalendarOccurrenceException.occurrence_key == key,
                )
            )
            if exception is not None and exception.cancelled and not payload:
                payload = {"title": fields.title}
            if payload:
                await self._execute(
                    [
                        CalendarMutation(
                            "update",
                            "event",
                            payload,
                            event.id,
                            scope="occurrence",
                            occurrence_key=key,
                        )
                    ]
                )
                self.result.updated += 1
        if link is None:
            link = await self._link(event.id, version.id, key)
        if link is None:
            link = GoogleEventLink(
                owner_id=self.user.id,
                series_id=event.id,
                version_id=version.id,
                occurrence_key=key,
                google_event_id=item["id"],
            )
            self.session.add(link)
        link.etag = item.get("etag")
        link.content_hash = None
        await self.session.flush()

    # -- outbound ---------------------------------------------------------------------

    @staticmethod
    def _all_day(link: GoogleEventLink | None, event: Event, version: CalendarScheduleVersion):
        return bool(
            link is not None
            and link.all_day
            and can_be_all_day(
                aware_utc(version.anchor_at), event.duration_minutes, version.timezone
            )
        )

    async def _notifications(
        self, event: Event, version: CalendarScheduleVersion, link: GoogleEventLink | None
    ) -> dict[str, Any] | None:
        """Google notifications for reminders tied to a single (non-recurring) event.

        A planner reminder fires once, while a Google notification repeats on every
        occurrence, so recurring series keep their reminders local. ``None`` leaves the
        Google event's own notifications untouched.
        """
        offsets: set[int] = set()
        if version.recurrence is None:
            rows = await self.session.scalars(
                select(Reminder.relative_offset_minutes).where(
                    Reminder.owner_id == self.user.id,
                    Reminder.linked_resource == "event",
                    Reminder.linked_id == event.id,
                    Reminder.status.in_(("active", "fired")),
                    Reminder.relative_offset_minutes.is_not(None),
                )
            )
            offsets = {-offset for offset in rows.all() if -MAX_NOTIFICATION_MINUTES <= offset <= 0}
        if offsets:
            return {
                "useDefault": False,
                "overrides": [
                    {"method": "popup", "minutes": minutes}
                    for minutes in sorted(offsets)[:MAX_NOTIFICATIONS]
                ],
            }
        if link is not None and link.reminders_pushed:
            return {"useDefault": True}
        return None

    async def _master_body(
        self, event: Event, version: CalendarScheduleVersion, link: GoogleEventLink | None
    ) -> dict[str, Any]:
        return master_body(
            event,
            version,
            all_day=self._all_day(link, event, version),
            event_type=link.event_type if link is not None else "default",
            reminders=await self._notifications(event, version, link),
        )

    async def _reminder_event_ids(self, reminder_ids: list[uuid.UUID]) -> list[uuid.UUID]:
        if not reminder_ids:
            return []
        rows = await self.session.scalars(
            select(Reminder.linked_id).where(
                Reminder.owner_id == self.user.id,
                Reminder.id.in_(reminder_ids),
                Reminder.linked_resource == "event",
            )
        )
        return [value for value in rows.all() if value is not None]

    async def push(self) -> None:
        operations = list(
            (
                await self.session.execute(
                    select(
                        CalendarOperation.sequence,
                        CalendarOperation.target_id,
                        CalendarOperation.resource,
                        CalendarOperation.origin,
                    )
                    .where(
                        CalendarOperation.owner_id == self.user.id,
                        CalendarOperation.sequence > self.account.pushed_sequence,
                    )
                    .order_by(CalendarOperation.sequence)
                )
            ).all()
        )
        if not operations:
            return
        series_ids: list[uuid.UUID] = []
        reminder_ids: list[uuid.UUID] = []
        for _sequence, target_id, resource, origin in operations:
            if origin == "google":
                continue
            if resource == "event" and target_id not in series_ids:
                series_ids.append(target_id)
            elif resource == "reminder":
                reminder_ids.append(target_id)
        for series_id in await self._reminder_event_ids(reminder_ids):
            if series_id not in series_ids:
                series_ids.append(series_id)
        for series_id in series_ids:
            try:
                await self.push_series(series_id)
            except GoogleApiError as exc:
                if not is_permanent_rejection(exc):
                    raise
                # Keep the queue moving; links of requests that did succeed are kept.
                self.result.skipped += 1
                logger.warning(
                    "Google rejected changes of series %s for %s: %s", series_id, self.user.id, exc
                )
            await self.session.commit()
        self.account.pushed_sequence = operations[-1][0]
        await self.session.flush()

    async def push_series(self, series_id: uuid.UUID) -> None:
        event = await self._event(series_id)
        links = list(
            (
                await self.session.scalars(
                    select(GoogleEventLink).where(
                        GoogleEventLink.owner_id == self.user.id,
                        GoogleEventLink.series_id == series_id,
                    )
                )
            ).all()
        )
        live: set[uuid.UUID] = set()
        if event is not None:
            versions = await OccurrenceService._series_versions(
                self.session, self.user, "event", series_id
            )
            for version in versions:
                if version_is_empty(version):
                    continue
                live.add(version.id)
                await self._push_version(event, version)
        for link in links:
            if link.version_id in live or link.occurrence_key:
                continue
            await self.client.delete_event(
                self.access_token, self.account.calendar_id, link.google_event_id
            )
            await self._drop_version_links(series_id, link.version_id)
            self.result.deleted += 1
        if event is None:
            await self.session.execute(
                delete(GoogleEventLink).where(
                    GoogleEventLink.owner_id == self.user.id,
                    GoogleEventLink.series_id == series_id,
                )
            )
        await self.session.flush()

    async def _push_version(self, event: Event, version: CalendarScheduleVersion) -> None:
        link = await self._link(event.id, version.id)
        all_day = self._all_day(link, event, version)
        body = await self._master_body(event, version, link)
        digest = content_hash(body)
        master_changed = False
        if link is None:
            created = await self.client.insert_event(
                self.access_token, self.account.calendar_id, body
            )
            link = GoogleEventLink(
                owner_id=self.user.id,
                series_id=event.id,
                version_id=version.id,
                google_event_id=created["id"],
                etag=created.get("etag"),
                content_hash=digest,
                all_day=all_day,
            )
            self.session.add(link)
            master_changed = True
        elif link.content_hash != digest:
            try:
                saved = await self.client.update_event(
                    self.access_token, self.account.calendar_id, link.google_event_id, body
                )
            except GoogleEventMissing:
                saved = await self.client.insert_event(
                    self.access_token, self.account.calendar_id, body
                )
                await self.session.execute(
                    delete(GoogleEventLink).where(
                        GoogleEventLink.owner_id == self.user.id,
                        GoogleEventLink.series_id == event.id,
                        GoogleEventLink.version_id == version.id,
                        GoogleEventLink.occurrence_key != "",
                    )
                )
                link.google_event_id = saved["id"]
            link.etag = saved.get("etag")
            link.content_hash = digest
            link.all_day = all_day
            master_changed = True
        if master_changed:
            self.result.pushed += 1
            link.reminders_pushed = bool((body.get("reminders") or {}).get("overrides"))
        await self.session.flush()
        if version.recurrence is not None and link.event_type not in RESTRICTED_FIELDS:
            await self._push_exceptions(event, version, link, all_day, force=master_changed)

    async def _push_exceptions(
        self,
        event: Event,
        version: CalendarScheduleVersion,
        master: GoogleEventLink,
        all_day: bool,
        *,
        force: bool,
    ) -> None:
        exceptions = list(
            (
                await self.session.scalars(
                    select(CalendarOccurrenceException).where(
                        CalendarOccurrenceException.owner_id == self.user.id,
                        CalendarOccurrenceException.resource == "event",
                        CalendarOccurrenceException.series_id == event.id,
                        CalendarOccurrenceException.version_id == version.id,
                    )
                )
            ).all()
        )
        for exception in exceptions:
            occurrence = await OccurrenceService.get(
                self.session, self.user, "event", event.id, exception.occurrence_key
            )
            if occurrence is None:
                continue
            google_id = instance_id(
                master.google_event_id,
                occurrence.original_at,
                version.timezone,
                all_day=all_day,
            )
            body = (
                {"status": "cancelled"}
                if exception.cancelled
                else instance_body(
                    occurrence.data,
                    master.google_event_id,
                    occurrence.original_at,
                    version.timezone,
                    all_day=all_day,
                )
            )
            digest = content_hash(body)
            link = await self._link(event.id, version.id, exception.occurrence_key)
            if link is not None and link.content_hash == digest and not force:
                continue
            etag = None
            if exception.cancelled:
                await self.client.delete_event(
                    self.access_token, self.account.calendar_id, google_id
                )
            else:
                try:
                    saved = await self.client.update_event(
                        self.access_token, self.account.calendar_id, google_id, body
                    )
                except GoogleEventMissing:
                    continue
                etag = saved.get("etag")
            if link is None:
                link = await self._link_by_google_id(google_id)
            if link is None:
                link = GoogleEventLink(
                    owner_id=self.user.id,
                    series_id=event.id,
                    version_id=version.id,
                    occurrence_key=exception.occurrence_key,
                    google_event_id=google_id,
                )
                self.session.add(link)
            link.etag = etag
            link.content_hash = digest
            self.result.pushed += 1
            await self.session.flush()
