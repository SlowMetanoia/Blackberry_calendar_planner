import json
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import CalendarOperation, Event, Task, User
from .schemas import EventCreate, EventUpdate, TaskCreate, TaskUpdate
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


MODELS = {"task": Task, "event": Event}
DATETIME_FIELDS = {"task": {"deadline"}, "event": {"starts_at"}}
CREATE_SCHEMAS = {"task": TaskCreate, "event": EventCreate}
UPDATE_SCHEMAS = {"task": TaskUpdate, "event": EventUpdate}
OPERATIONS = {"create", "update", "delete"}
ORIGINS = {"agent", "rest", "undo"}


def _json_value(value: Any) -> Any:
    return json.loads(json.dumps(value, default=str))


def resource_snapshot(obj: Task | Event) -> dict[str, Any]:
    return _json_value(
        {
            column.name: getattr(obj, column.name)
            for column in obj.__table__.columns
            if column.name != "owner_id"
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
    return CalendarMutation(value.operation, value.resource, payload, value.target_id)


def _validated_mutation(value: Any, user: User) -> CalendarMutation:
    try:
        mutation = _mutation(value)
    except (TypeError, AttributeError) as exc:
        raise CalendarValidationError("Некорректный формат календарного действия") from exc
    if mutation.operation not in OPERATIONS:
        raise CalendarValidationError(f"Unsupported operation: {mutation.operation}")
    if mutation.resource not in MODELS:
        raise CalendarValidationError(f"Unsupported resource: {mutation.resource}")
    if not isinstance(mutation.payload, dict):
        raise CalendarValidationError("Mutation payload must be an object")
    if mutation.operation in {"update", "delete"} and mutation.target_id is None:
        raise CalendarValidationError("target_id is required")
    target_id = mutation.target_id
    if target_id is not None:
        try:
            target_id = uuid.UUID(str(target_id))
        except (TypeError, ValueError, AttributeError) as exc:
            raise CalendarValidationError("target_id must be a UUID") from exc
    try:
        if mutation.operation == "create":
            payload = (
                CREATE_SCHEMAS[mutation.resource]
                .model_validate(mutation.payload)
                .model_dump(mode="python")
            )
        elif mutation.operation == "update":
            payload = (
                UPDATE_SCHEMAS[mutation.resource]
                .model_validate(mutation.payload)
                .model_dump(exclude_unset=True, mode="python")
            )
        else:
            if mutation.payload:
                raise CalendarValidationError("delete payload must be empty")
            payload = {}
    except ValidationError as exc:
        raise CalendarValidationError("Некорректные данные календарного действия") from exc
    try:
        normalized = _normalize_payload(payload, user, DATETIME_FIELDS[mutation.resource])
    except (TypeError, ValueError) as exc:
        raise CalendarValidationError("Некорректная дата календарного действия") from exc
    return CalendarMutation(mutation.operation, mutation.resource, normalized, target_id)


class CalendarCommandService:
    @staticmethod
    async def _owned(session: AsyncSession, user: User, resource: str, target_id: uuid.UUID):
        model = MODELS[resource]
        return await session.scalar(
            select(model).where(model.id == target_id, model.owner_id == user.id).with_for_update()
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
        async with session.begin_nested():
            for ordinal, mutation in enumerate(validated):
                model = MODELS[mutation.resource]
                before = None
                target_id = mutation.target_id
                payload = mutation.payload
                if mutation.operation == "create":
                    target_id = target_id or uuid.uuid4()
                    obj = model(id=target_id, owner_id=user.id, **payload)
                    session.add(obj)
                    await session.flush()
                    after = resource_snapshot(obj)
                else:
                    obj = await cls._owned(session, user, mutation.resource, target_id)
                    if obj is None:
                        raise CalendarTargetNotFound(f"{mutation.resource} not found")
                    before = resource_snapshot(obj)
                    if mutation.operation == "update":
                        for key, value in payload.items():
                            setattr(obj, key, value)
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
                sequence += 1
                operation = CalendarOperation(
                    owner_id=user.id,
                    sequence=sequence,
                    command_id=command_id,
                    ordinal=ordinal,
                    operation=mutation.operation,
                    resource=mutation.resource,
                    target_id=target_id,
                    before_state=before,
                    after_state=after,
                    changes=changes,
                    origin=origin,
                    source_message_id=source_message_id,
                )
                session.add(operation)
                result.append(operation)
            await session.flush()
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
        current = await cls._owned(session, user, original.resource, original.target_id)
        current_state = resource_snapshot(current) if current is not None else None
        if original.operation == "create":
            if current_state != original.after_state:
                raise UndoConflict(
                    "Объект изменился после создания и не может быть отменён автоматически"
                )
            inverse = CalendarMutation("delete", original.resource, {}, original.target_id)
        elif original.operation == "update":
            if current is None or any(
                current_state.get(field) != change.get("after")
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
        for operation, normalized in prepared:
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
                    setattr(current, key, value)
        await session.flush()
