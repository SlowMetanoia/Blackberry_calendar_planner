import json
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from pydantic import ValidationError
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import (
    CalendarOccurrenceException,
    CalendarOperation,
    CalendarScheduleVersion,
    Event,
    Reminder,
    Task,
    User,
)
from .occurrences import OccurrenceService, aware_utc, occurrence_key, parse_occurrence_key
from .recurrence import expand_recurrence
from .reminders import resolve_reminder
from .schemas import (
    EventCreate,
    EventUpdate,
    ReminderCreate,
    ReminderUpdate,
    TaskCreate,
    TaskUpdate,
)
from .search import mark_search_index_dirty, rebuild_search_documents, sync_search_document
from .services import _normalize_payload


class CalendarTargetNotFound(LookupError):
    pass


class UndoConflict(RuntimeError):
    pass


class CalendarValidationError(ValueError):
    pass


class CalendarHistoryCorrupt(RuntimeError):
    pass


@dataclass(frozen=True)
class CalendarMutation:
    operation: str
    resource: str
    payload: dict[str, Any]
    target_id: uuid.UUID | None = None
    scope: str = "series"
    occurrence_key: str | None = None
    effective_from_occurrence_key: str | None = None


MODELS = {"task": Task, "event": Event, "reminder": Reminder}
DATETIME_FIELDS = {"task": {"deadline"}, "event": {"starts_at"}, "reminder": {"remind_at"}}
CREATE_SCHEMAS = {"task": TaskCreate, "event": EventCreate, "reminder": ReminderCreate}
UPDATE_SCHEMAS = {"task": TaskUpdate, "event": EventUpdate, "reminder": ReminderUpdate}
OPERATIONS = {"create", "update", "delete"}
ORIGINS = {"agent", "rest", "undo", "google"}


def _json_value(value: Any) -> Any:
    return json.loads(json.dumps(value, default=str))


def _snapshot_value_equal(left: Any, right: Any) -> bool:
    if left == right:
        return True
    if isinstance(left, str) and isinstance(right, str):
        try:
            left_date = datetime.fromisoformat(left)
            right_date = datetime.fromisoformat(right)
            if left_date.tzinfo is None:
                left_date = left_date.replace(tzinfo=UTC)
            if right_date.tzinfo is None:
                right_date = right_date.replace(tzinfo=UTC)
            return left_date == right_date
        except ValueError:
            return False
    return False


def resource_snapshot(obj: Task | Event | Reminder) -> dict[str, Any]:
    if isinstance(obj, Reminder):
        for name in ("remind_at", "cancelled_at"):
            value = getattr(obj, name)
            if value is not None and value.tzinfo is None:
                setattr(obj, name, value.replace(tzinfo=UTC))
    return _json_value(
        {
            column.name: getattr(obj, column.name)
            for column in obj.__table__.columns
            if column.name not in {"owner_id", "recurrence_version_id"}
            and not (isinstance(obj, Reminder) and column.name in {"created_at", "fired_at"})
            and not (
                column.name in {"recurrence", "recurrence_timezone"}
                and getattr(obj, column.name) is None
            )
        }
    )


def operation_dict(operation: CalendarOperation) -> dict[str, Any]:
    return {
        "id": str(operation.id),
        "sequence": operation.sequence,
        "command_id": str(operation.command_id),
        "ordinal": operation.ordinal,
        "operation": operation.operation,
        "resource": operation.resource,
        "target_id": str(operation.target_id),
        "scope": operation.scope,
        "occurrence_key": operation.occurrence_key,
        "effective_from_occurrence_key": operation.effective_from_occurrence_key,
        "before": operation.before_state,
        "after": operation.after_state,
        "changes": operation.changes,
        "origin": operation.origin,
        "source_message_id": str(operation.source_message_id)
        if operation.source_message_id
        else None,
        "reverts_operation_id": str(operation.reverts_operation_id)
        if operation.reverts_operation_id
        else None,
        "created_at": operation.created_at.isoformat() if operation.created_at else None,
    }


def _mutation(value: Any) -> CalendarMutation:
    if isinstance(value, CalendarMutation):
        return value
    if isinstance(value, dict):
        return CalendarMutation(**value)
    payload = value.payload.model_dump(exclude_unset=True, mode="python")
    return CalendarMutation(
        value.operation,
        value.resource,
        payload,
        value.target_id,
        getattr(value, "scope", "series"),
        getattr(value, "occurrence_key", None),
        getattr(value, "effective_from_occurrence_key", None),
    )


def _validated_mutation(value: Any, user: User) -> CalendarMutation:
    try:
        mutation = _mutation(value)
    except (TypeError, AttributeError) as exc:
        raise CalendarValidationError("Некорректный формат календарного действия") from exc
    if mutation.operation not in OPERATIONS:
        raise CalendarValidationError(f"Unsupported operation: {mutation.operation}")
    if mutation.resource not in MODELS:
        raise CalendarValidationError(f"Unsupported resource: {mutation.resource}")
    if mutation.resource == "reminder" and mutation.operation == "delete":
        mutation = CalendarMutation(
            "update",
            "reminder",
            {"status": "cancelled"},
            mutation.target_id,
            mutation.scope,
            mutation.occurrence_key,
        )
    if mutation.scope not in {"series", "occurrence"}:
        raise CalendarValidationError("scope must be series or occurrence")
    if mutation.scope == "occurrence" and (
        mutation.operation == "create" or mutation.target_id is None or not mutation.occurrence_key
    ):
        raise CalendarValidationError("occurrence mutations require target_id and occurrence_key")
    if not isinstance(mutation.payload, dict):
        raise CalendarValidationError("Mutation payload must be an object")
    if (
        mutation.scope == "occurrence"
        and {
            "recurrence",
            "recurrence_timezone",
        }
        & mutation.payload.keys()
    ):
        raise CalendarValidationError("recurrence can only be changed for a series")
    if mutation.operation in {"update", "delete"} and mutation.target_id is None:
        raise CalendarValidationError("target_id is required")
    target_id = mutation.target_id
    if target_id is not None:
        try:
            target_id = uuid.UUID(str(target_id))
        except (TypeError, ValueError, AttributeError) as exc:
            raise CalendarValidationError("target_id must be a UUID") from exc
    try:
        internal = {}
        raw_payload = dict(mutation.payload)
        if mutation.resource == "reminder":
            # Older reminder snapshots also stored delivery timestamps. They
            # remain operational state and must never reactivate a fired item.
            raw_payload.pop("created_at", None)
            raw_payload.pop("fired_at", None)
            for field in (
                "cancelled_reason",
                "cancelled_at",
                *(["status"] if mutation.operation == "create" else []),
            ):
                if field in raw_payload:
                    internal[field] = raw_payload.pop(field)
        if mutation.operation == "create":
            payload = (
                CREATE_SCHEMAS[mutation.resource]
                .model_validate(raw_payload)
                .model_dump(mode="python")
            )
            if payload.get("recurrence") is not None and not payload.get("recurrence_timezone"):
                payload["recurrence_timezone"] = user.timezone
        elif mutation.operation == "update":
            payload = (
                UPDATE_SCHEMAS[mutation.resource]
                .model_validate(raw_payload)
                .model_dump(exclude_unset=True, mode="python")
            )
        else:
            if mutation.payload:
                raise CalendarValidationError("delete payload must be empty")
            payload = {}
    except ValidationError as exc:
        raise CalendarValidationError("Некорректные данные календарного действия") from exc
    payload.update(internal)
    try:
        normalized = _normalize_payload(
            payload,
            user,
            DATETIME_FIELDS[mutation.resource]
            | ({"cancelled_at"} if mutation.resource == "reminder" else set()),
        )
    except (TypeError, ValueError) as exc:
        raise CalendarValidationError("Некорректная дата календарного действия") from exc
    return CalendarMutation(
        mutation.operation,
        mutation.resource,
        normalized,
        target_id,
        mutation.scope,
        mutation.occurrence_key,
        mutation.effective_from_occurrence_key,
    )


class CalendarCommandService:
    @staticmethod
    async def _owned(session: AsyncSession, user: User, resource: str, target_id: uuid.UUID):
        model = MODELS[resource]
        return await session.scalar(
            select(model).where(model.id == target_id, model.owner_id == user.id).with_for_update()
        )

    @classmethod
    async def _refresh_recurring_task_status(
        cls, session: AsyncSession, user: User, task: Task
    ) -> None:
        if task.recurrence is None:
            return
        versions = await OccurrenceService._series_versions(session, user, "task", task.id)
        if not versions or any(
            not version.recurrence
            or (version.recurrence.get("end") or {}).get("kind", "never") == "never"
            for version in versions
        ):
            task.status = "open"
            return
        first = min(version.anchor_at for version in versions)
        page = await OccurrenceService.page(
            session,
            user,
            resource="task",
            series_id=task.id,
            from_datetime=first,
            to_datetime=datetime(9999, 1, 1, tzinfo=UTC),
            limit=100_000,
        )
        task.status = (
            "completed"
            if page.items and all(item.data.get("status") == "completed" for item in page.items)
            else "open"
        )

    @classmethod
    async def execute(
        cls,
        session: AsyncSession,
        user: User,
        mutations: Iterable[Any],
        *,
        origin: str,
        command_id: uuid.UUID | None = None,
        source_message_id: uuid.UUID | None = None,
    ) -> list[CalendarOperation]:
        if origin not in ORIGINS:
            raise CalendarValidationError(f"Unsupported origin: {origin}")
        validated = [_validated_mutation(raw, user) for raw in mutations]
        command_id = command_id or uuid.uuid4()
        existing = list(
            (
                await session.scalars(
                    select(CalendarOperation)
                    .where(
                        CalendarOperation.owner_id == user.id,
                        CalendarOperation.command_id == command_id,
                    )
                    .order_by(CalendarOperation.ordinal)
                )
            ).all()
        )
        if existing:
            return existing

        await session.scalar(select(User.id).where(User.id == user.id).with_for_update())
        sequence = int(
            await session.scalar(
                select(func.max(CalendarOperation.sequence)).where(
                    CalendarOperation.owner_id == user.id
                )
            )
            or 0
        )
        result: list[CalendarOperation] = []
        search_projection_changed = False
        async with session.begin_nested():
            for ordinal, mutation in enumerate(validated):
                model = MODELS[mutation.resource]
                before = None
                target_id = mutation.target_id
                payload = mutation.payload
                if mutation.resource == "reminder":
                    current = (
                        await cls._owned(session, user, "reminder", target_id)
                        if target_id
                        else None
                    )
                    if mutation.operation == "update" and current is None:
                        raise CalendarTargetNotFound("reminder not found")
                    if current is not None and current.status == "cancelled" and origin != "undo":
                        raise CalendarValidationError("Отменённое напоминание нельзя изменить")
                    try:
                        payload = await resolve_reminder(session, user, payload, current=current)
                    except ValueError as exc:
                        raise CalendarValidationError(str(exc)) from exc
                resolved_effective_from = mutation.effective_from_occurrence_key
                if mutation.scope == "occurrence":
                    if mutation.resource == "reminder":
                        raise CalendarValidationError("reminders do not support occurrences")
                    obj = await cls._owned(session, user, mutation.resource, target_id)
                    if obj is None:
                        raise CalendarTargetNotFound(f"{mutation.resource} not found")
                    occurrence = await OccurrenceService.get(
                        session,
                        user,
                        mutation.resource,
                        target_id,
                        mutation.occurrence_key or "",
                    )
                    if occurrence is None:
                        raise CalendarTargetNotFound("calendar occurrence not found")
                    before = _json_value(occurrence.data)
                    version_id, original_at = parse_occurrence_key(mutation.occurrence_key or "")
                    exception = await session.scalar(
                        select(CalendarOccurrenceException).where(
                            CalendarOccurrenceException.owner_id == user.id,
                            CalendarOccurrenceException.resource == mutation.resource,
                            CalendarOccurrenceException.series_id == target_id,
                            CalendarOccurrenceException.occurrence_key == mutation.occurrence_key,
                        )
                    )
                    if exception is None:
                        exception = CalendarOccurrenceException(
                            owner_id=user.id,
                            resource=mutation.resource,
                            series_id=target_id,
                            occurrence_key=mutation.occurrence_key,
                            version_id=version_id,
                            original_at=original_at,
                            effective_at=occurrence.scheduled_at,
                            patch={},
                        )
                        session.add(exception)
                    if mutation.operation == "update":
                        schedule_field = (
                            "deadline"
                            if mutation.resource == "task"
                            else "starts_at"
                            if mutation.resource == "event"
                            else "remind_at"
                        )
                        exception.patch = _json_value({**(exception.patch or {}), **payload})
                        if schedule_field in payload:
                            exception.effective_at = payload[schedule_field]
                        exception.cancelled = False
                        after = {**before, **_json_value(payload)}
                    else:
                        exception.cancelled = True
                        after = None
                    await session.flush()
                    if mutation.resource == "task":
                        await cls._refresh_recurring_task_status(session, user, obj)
                    changed_keys = set(before or {}) | set(after or {})
                    changes = {
                        key: {"before": (before or {}).get(key), "after": (after or {}).get(key)}
                        for key in changed_keys
                        if (before or {}).get(key) != (after or {}).get(key)
                    }
                    sequence += 1
                    operation = CalendarOperation(
                        owner_id=user.id,
                        sequence=sequence,
                        command_id=command_id,
                        ordinal=len(result),
                        operation=mutation.operation,
                        resource=mutation.resource,
                        target_id=target_id,
                        scope="occurrence",
                        occurrence_key=mutation.occurrence_key,
                        before_state=before,
                        after_state=after,
                        changes=changes,
                        origin=origin,
                        source_message_id=source_message_id,
                    )
                    session.add(operation)
                    result.append(operation)
                    if {"title", "description"} & payload.keys():
                        await mark_search_index_dirty(session, user.id)
                    continue
                if mutation.operation == "create":
                    target_id = target_id or uuid.uuid4()
                    obj = model(id=target_id, owner_id=user.id, **payload)
                    session.add(obj)
                    await session.flush()
                    anchor = (
                        obj.deadline
                        if mutation.resource == "task"
                        else obj.starts_at
                        if mutation.resource == "event"
                        else None
                    )
                    if anchor is not None:
                        retained = await session.scalar(
                            select(CalendarScheduleVersion)
                            .where(
                                CalendarScheduleVersion.owner_id == user.id,
                                CalendarScheduleVersion.resource == mutation.resource,
                                CalendarScheduleVersion.series_id == target_id,
                            )
                            .order_by(CalendarScheduleVersion.active_from.desc())
                        )
                        if retained is not None:
                            obj.recurrence_version_id = retained.id
                        else:
                            version_id = uuid.uuid4()
                            obj.recurrence_version_id = version_id
                            session.add(
                                CalendarScheduleVersion(
                                    id=version_id,
                                    owner_id=user.id,
                                    resource=mutation.resource,
                                    series_id=target_id,
                                    anchor_at=anchor,
                                    recurrence=obj.recurrence,
                                    timezone=obj.recurrence_timezone or user.timezone,
                                    active_from=anchor,
                                )
                            )
                        await session.flush()
                    after = resource_snapshot(obj)
                else:
                    obj = await cls._owned(session, user, mutation.resource, target_id)
                    if obj is None:
                        raise CalendarTargetNotFound(f"{mutation.resource} not found")
                    before = resource_snapshot(obj)
                    if mutation.operation == "update":
                        if "recurrence" in payload:
                            if payload["recurrence"] is None:
                                payload.setdefault("recurrence_timezone", None)
                            elif not payload.get("recurrence_timezone") and not getattr(
                                obj, "recurrence_timezone", None
                            ):
                                payload["recurrence_timezone"] = user.timezone
                        candidate = dict(before)
                        candidate.pop("id", None)
                        candidate.update(_json_value(payload))
                        try:
                            if mutation.resource == "reminder":
                                candidate = {
                                    key: value
                                    for key, value in candidate.items()
                                    if key in ReminderCreate.model_fields
                                }
                            CREATE_SCHEMAS[mutation.resource].model_validate(candidate)
                        except ValidationError as exc:
                            raise CalendarValidationError(
                                "Некорректное итоговое состояние календарной записи"
                            ) from exc
                        schedule_field = (
                            "deadline"
                            if mutation.resource == "task"
                            else "starts_at"
                            if mutation.resource == "event"
                            else "remind_at"
                        )
                        schedule_changed = mutation.resource != "reminder" and bool(
                            {schedule_field, "recurrence", "recurrence_timezone"} & payload.keys()
                        )
                        current_version = (
                            await session.get(CalendarScheduleVersion, obj.recurrence_version_id)
                            if getattr(obj, "recurrence_version_id", None)
                            else None
                        )
                        if (
                            schedule_changed
                            and current_version is not None
                            and current_version.recurrence is not None
                            and resolved_effective_from is None
                        ):
                            now = datetime.now(UTC)
                            upcoming = expand_recurrence(
                                aware_utc(current_version.anchor_at),
                                current_version.recurrence,
                                current_version.timezone,
                                now,
                                now + timedelta(days=366 * 100),
                                limit=1,
                            )
                            if upcoming:
                                resolved_effective_from = occurrence_key(
                                    current_version.id, upcoming[0]
                                )
                        for key, value in payload.items():
                            setattr(obj, key, value)
                        if schedule_changed:
                            anchor = getattr(obj, schedule_field)
                            if anchor is not None and current_version is None:
                                version_id = uuid.uuid4()
                                obj.recurrence_version_id = version_id
                                session.add(
                                    CalendarScheduleVersion(
                                        id=version_id,
                                        owner_id=user.id,
                                        resource=mutation.resource,
                                        series_id=target_id,
                                        anchor_at=anchor,
                                        recurrence=obj.recurrence,
                                        timezone=obj.recurrence_timezone or user.timezone,
                                        active_from=anchor,
                                    )
                                )
                            elif current_version is not None and resolved_effective_from:
                                _old_version, boundary = parse_occurrence_key(
                                    resolved_effective_from
                                )
                                current_version.active_until = boundary
                                version_id = uuid.uuid4()
                                obj.recurrence_version_id = version_id
                                session.add(
                                    CalendarScheduleVersion(
                                        id=version_id,
                                        owner_id=user.id,
                                        resource=mutation.resource,
                                        series_id=target_id,
                                        anchor_at=anchor or boundary,
                                        recurrence=obj.recurrence,
                                        timezone=obj.recurrence_timezone or user.timezone,
                                        active_from=boundary,
                                    )
                                )
                            elif current_version is not None and anchor is not None:
                                current_version.anchor_at = anchor
                                current_version.active_from = anchor
                                current_version.recurrence = obj.recurrence
                                current_version.timezone = obj.recurrence_timezone or user.timezone
                        await session.flush()
                        after = resource_snapshot(obj)
                    elif mutation.operation == "delete":
                        await session.delete(obj)
                        await session.flush()
                        after = None
                changed_keys = set(before or {}) | set(after or {})
                changes = {
                    key: {"before": (before or {}).get(key), "after": (after or {}).get(key)}
                    for key in changed_keys
                    if (before or {}).get(key) != (after or {}).get(key)
                }
                if mutation.operation == "update" and not changes:
                    continue
                await sync_search_document(
                    session,
                    user.id,
                    mutation.resource,
                    target_id,
                    after,
                )
                search_projection_changed = True
                sequence += 1
                operation = CalendarOperation(
                    owner_id=user.id,
                    sequence=sequence,
                    command_id=command_id,
                    ordinal=len(result),
                    operation=mutation.operation,
                    resource=mutation.resource,
                    target_id=target_id,
                    scope="series",
                    effective_from_occurrence_key=resolved_effective_from,
                    before_state=before,
                    after_state=after,
                    changes=changes,
                    origin=origin,
                    source_message_id=source_message_id,
                )
                session.add(operation)
                result.append(operation)
                await session.flush()
                if mutation.resource in {"task", "event"}:
                    linked = list(
                        (
                            await session.scalars(
                                select(Reminder)
                                .where(
                                    Reminder.owner_id == user.id,
                                    Reminder.linked_resource == mutation.resource,
                                    Reminder.linked_id == target_id,
                                )
                                .with_for_update()
                            )
                        ).all()
                    )
                    source_reason = (
                        f"deleted:{operation.id}"
                        if after is None
                        else f"completed:{operation.id}"
                        if mutation.resource == "task" and after.get("status") == "completed"
                        else None
                    )
                    anchor_field = "deadline" if mutation.resource == "task" else "starts_at"
                    for reminder in linked:
                        previous = resource_snapshot(reminder)
                        if source_reason and reminder.status == "active":
                            reminder.status = "cancelled"
                            reminder.cancelled_reason = source_reason
                            reminder.cancelled_at = datetime.now(UTC)
                        elif after is not None:
                            if (
                                reminder.status == "cancelled"
                                and (reminder.cancelled_reason or "").startswith("completed:")
                                and mutation.resource == "task"
                                and after.get("status") == "open"
                            ):
                                reminder.status = "active"
                                reminder.cancelled_reason = None
                                reminder.cancelled_at = None
                            if (
                                reminder.status == "active"
                                and reminder.relative_offset_minutes is not None
                            ):
                                anchor = after.get(anchor_field)
                                if anchor is None:
                                    raise CalendarValidationError(
                                        "Сначала удалите относительные напоминания перед снятием срока"
                                    )
                                reminder.remind_at = datetime.fromisoformat(anchor) + timedelta(
                                    minutes=reminder.relative_offset_minutes
                                )
                        updated = resource_snapshot(reminder)
                        if previous != updated:
                            sequence += 1
                            session.add(
                                CalendarOperation(
                                    owner_id=user.id,
                                    sequence=sequence,
                                    command_id=command_id,
                                    ordinal=len(result),
                                    operation="update",
                                    resource="reminder",
                                    target_id=reminder.id,
                                    scope="series",
                                    before_state=previous,
                                    after_state=updated,
                                    changes={
                                        key: {
                                            "before": previous.get(key),
                                            "after": updated.get(key),
                                        }
                                        for key in previous.keys() | updated.keys()
                                        if previous.get(key) != updated.get(key)
                                    },
                                    origin=origin,
                                    source_message_id=source_message_id,
                                )
                            )
                            await session.flush()
                            result.append(
                                await session.scalar(
                                    select(CalendarOperation).where(
                                        CalendarOperation.owner_id == user.id,
                                        CalendarOperation.sequence == sequence,
                                    )
                                )
                            )
            await session.flush()
            if search_projection_changed:
                await mark_search_index_dirty(session, user.id)
        return result

    @classmethod
    async def undo(
        cls, session: AsyncSession, user: User, operation_id: uuid.UUID
    ) -> CalendarOperation:
        original = await session.scalar(
            select(CalendarOperation).where(
                CalendarOperation.id == operation_id,
                CalendarOperation.owner_id == user.id,
            )
        )
        if original is None:
            raise CalendarTargetNotFound("Calendar operation not found")
        if original.scope == "occurrence":
            current = await OccurrenceService.get(
                session,
                user,
                original.resource,
                original.target_id,
                original.occurrence_key or "",
            )
            exception = await session.scalar(
                select(CalendarOccurrenceException).where(
                    CalendarOccurrenceException.owner_id == user.id,
                    CalendarOccurrenceException.resource == original.resource,
                    CalendarOccurrenceException.series_id == original.target_id,
                    CalendarOccurrenceException.occurrence_key == original.occurrence_key,
                )
            )
            if current is None or exception is None:
                raise UndoConflict("Экземпляр серии больше не существует")
            if original.operation == "delete":
                if not exception.cancelled:
                    raise UndoConflict("Удаление экземпляра уже отменено")
                payload = dict(original.before_state or {})
                payload = {
                    field: payload.get(field)
                    for field in original.changes
                    if field not in {"id", "recurrence", "recurrence_timezone"}
                }
            elif original.operation == "update":
                if exception.cancelled or any(
                    not _snapshot_value_equal(
                        _json_value(current.data.get(field)), change.get("after")
                    )
                    for field, change in original.changes.items()
                ):
                    raise UndoConflict("Экземпляр уже имеет другие значения")
                payload = {
                    field: change.get("before")
                    for field, change in original.changes.items()
                    if field not in {"id", "recurrence", "recurrence_timezone"}
                }
            else:
                raise UndoConflict("Создание экземпляра нельзя отменить отдельно")
            inverse = CalendarMutation(
                "update",
                original.resource,
                payload,
                original.target_id,
                scope="occurrence",
                occurrence_key=original.occurrence_key,
            )
            operation = (await cls.execute(session, user, [inverse], origin="undo"))[0]
            operation.reverts_operation_id = original.id
            await session.flush()
            return operation
        current = await cls._owned(session, user, original.resource, original.target_id)
        current_state = resource_snapshot(current) if current is not None else None
        if original.operation == "create":
            expected_state = original.after_state
            if original.resource == "reminder" and expected_state:
                expected_state = {
                    key: value
                    for key, value in expected_state.items()
                    if key not in {"created_at", "fired_at"}
                }
            if current_state != expected_state:
                raise UndoConflict(
                    "Объект изменился после создания и не может быть отменён автоматически"
                )
            inverse = CalendarMutation("delete", original.resource, {}, original.target_id)
        elif original.operation == "update":
            if current is None or any(
                not _snapshot_value_equal(current_state.get(field), change.get("after"))
                for field, change in original.changes.items()
            ):
                raise UndoConflict("Изменённые поля уже имеют другие значения")
            inverse = CalendarMutation(
                "update",
                original.resource,
                {field: change.get("before") for field, change in original.changes.items()},
                original.target_id,
            )
        else:
            if current is not None:
                raise UndoConflict("Удалённый объект уже существует")
            snapshot = dict(original.before_state or {})
            snapshot.pop("id", None)
            inverse = CalendarMutation("create", original.resource, snapshot, original.target_id)
        operation = (await cls.execute(session, user, [inverse], origin="undo"))[0]
        if original.resource in {"task", "event"}:
            reason = (
                f"deleted:{original.id}"
                if original.operation == "delete"
                else f"completed:{original.id}"
                if original.resource == "task"
                and (original.after_state or {}).get("status") == "completed"
                and (original.before_state or {}).get("status") != "completed"
                else None
            )
            if reason:
                reminders = list(
                    (
                        await session.scalars(
                            select(Reminder).where(
                                Reminder.owner_id == user.id,
                                Reminder.linked_resource == original.resource,
                                Reminder.linked_id == original.target_id,
                                Reminder.status == "cancelled",
                                Reminder.cancelled_reason == reason,
                            )
                        )
                    ).all()
                )
                if reminders:
                    await cls.execute(
                        session,
                        user,
                        [
                            CalendarMutation(
                                "update", "reminder", {"status": "active"}, reminder.id
                            )
                            for reminder in reminders
                        ],
                        origin="undo",
                    )
        if original.operation == "update" and original.effective_from_occurrence_key:
            previous_version_id, boundary = parse_occurrence_key(
                original.effective_from_occurrence_key
            )
            previous_version = await session.get(CalendarScheduleVersion, previous_version_id)
            restored = await cls._owned(session, user, original.resource, original.target_id)
            if previous_version is None or restored is None:
                raise UndoConflict("Версия расписания больше не существует")
            await session.execute(
                delete(CalendarScheduleVersion).where(
                    CalendarScheduleVersion.owner_id == user.id,
                    CalendarScheduleVersion.resource == original.resource,
                    CalendarScheduleVersion.series_id == original.target_id,
                    CalendarScheduleVersion.id != previous_version_id,
                    CalendarScheduleVersion.active_from >= boundary,
                )
            )
            previous_version.active_until = None
            restored.recurrence_version_id = previous_version_id
        operation.reverts_operation_id = original.id
        await session.flush()
        return operation

    @classmethod
    async def replay(cls, session: AsyncSession, user: User) -> None:
        operations = list(
            (
                await session.scalars(
                    select(CalendarOperation)
                    .where(CalendarOperation.owner_id == user.id)
                    .order_by(CalendarOperation.sequence)
                )
            ).all()
        )
        prepared: list[tuple[CalendarOperation, dict[str, Any] | None]] = []
        try:
            for operation in operations:
                if operation.operation not in OPERATIONS or operation.resource not in MODELS:
                    raise CalendarHistoryCorrupt("Unsupported operation in calendar history")
                expected = {
                    "create": (False, True),
                    "update": (True, True),
                    "delete": (True, False),
                }[operation.operation]
                actual = (operation.before_state is not None, operation.after_state is not None)
                if actual != expected:
                    raise CalendarHistoryCorrupt("Invalid calendar history snapshots")
                if operation.scope == "occurrence":
                    prepared.append((operation, None))
                    continue
                if operation.after_state is None:
                    prepared.append((operation, None))
                    continue
                values = dict(operation.after_state)
                snapshot_id = values.pop("id", None)
                if snapshot_id is not None and uuid.UUID(str(snapshot_id)) != operation.target_id:
                    raise CalendarHistoryCorrupt("Calendar history target does not match snapshot")
                validated = _validated_mutation(
                    CalendarMutation("create", operation.resource, values, operation.target_id),
                    user,
                )
                prepared.append((operation, validated.payload))
        except (CalendarValidationError, TypeError, ValueError) as exc:
            if isinstance(exc, CalendarHistoryCorrupt):
                raise
            raise CalendarHistoryCorrupt("Calendar history contains invalid data") from exc

        await session.execute(delete(Task).where(Task.owner_id == user.id))
        await session.execute(delete(Event).where(Event.owner_id == user.id))
        await session.execute(
            delete(CalendarOccurrenceException).where(
                CalendarOccurrenceException.owner_id == user.id
            )
        )
        for operation, normalized in prepared:
            if operation.scope == "occurrence":
                version_id, original_at = parse_occurrence_key(operation.occurrence_key or "")
                exception = await session.scalar(
                    select(CalendarOccurrenceException).where(
                        CalendarOccurrenceException.owner_id == user.id,
                        CalendarOccurrenceException.resource == operation.resource,
                        CalendarOccurrenceException.series_id == operation.target_id,
                        CalendarOccurrenceException.occurrence_key == operation.occurrence_key,
                    )
                )
                if exception is None:
                    exception = CalendarOccurrenceException(
                        owner_id=user.id,
                        resource=operation.resource,
                        series_id=operation.target_id,
                        occurrence_key=operation.occurrence_key,
                        version_id=version_id,
                        original_at=original_at,
                        effective_at=original_at,
                        patch={},
                    )
                    session.add(exception)
                if operation.operation == "delete":
                    exception.cancelled = True
                else:
                    patch = dict(exception.patch or {})
                    for field, change in operation.changes.items():
                        patch[field] = change.get("after")
                    exception.patch = patch
                    schedule_field = (
                        "deadline"
                        if operation.resource == "task"
                        else "starts_at"
                        if operation.resource == "event"
                        else "remind_at"
                    )
                    if schedule_field in patch and patch[schedule_field] is not None:
                        value = patch[schedule_field]
                        exception.effective_at = (
                            datetime.fromisoformat(value) if isinstance(value, str) else value
                        )
                    exception.cancelled = False
                continue
            model = MODELS[operation.resource]
            current = await session.get(model, operation.target_id)
            if operation.after_state is None:
                if current is not None:
                    await session.delete(current)
                continue
            if current is None:
                session.add(model(id=operation.target_id, owner_id=user.id, **normalized))
            else:
                for key, value in normalized.items():
                    if (
                        operation.resource == "reminder"
                        and current.status == "fired"
                        and key == "status"
                    ):
                        continue
                    setattr(current, key, value)
        await session.flush()
        await rebuild_search_documents(session, user)
