import json
import uuid
from io import BytesIO

import pytest
from fastapi import HTTPException, UploadFile
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from planner.agent import parse_decision
from planner.calendar import CalendarCommandService, CalendarMutation, CalendarValidationError
from planner.db import Base
from planner.main import _save_audio_upload, validation_problem
from planner.models import CalendarOperation, User
from planner.schemas import AgentInput, EventUpdate, TaskCreate, TaskUpdate
from planner.services import TaskService


@pytest.mark.parametrize(
    ("model", "payload"),
    [
        (TaskCreate, {"title": "   "}),
        (TaskCreate, {"title": "ok", "unexpected": True}),
        (TaskUpdate, {}),
        (EventUpdate, {}),
        (AgentInput, {"text": "   "}),
        (AgentInput, {"text": "x" * 10_001}),
    ],
)
def test_public_inputs_reject_invalid_shapes(model, payload) -> None:
    with pytest.raises(ValidationError):
        model.model_validate(payload)


def test_optional_fields_can_still_be_cleared() -> None:
    assert TaskUpdate.model_validate({"description": None}).model_fields_set == {"description"}
    assert EventUpdate.model_validate({"location": None}).model_fields_set == {"location"}


@pytest.mark.parametrize(
    "payload",
    [
        {"title": None},
        {"status": None},
        {"status": "not-a-status"},
    ],
)
def test_decision_task_update_rejects_invalid_required_values(payload) -> None:
    raw = json.dumps(
        {
            "reply": "ok",
            "reads": [],
            "mutations": [
                {
                    "operation": "update",
                    "resource": "task",
                    "target_id": str(uuid.uuid4()),
                    "payload": payload,
                }
            ],
            "clarification": None,
        }
    )
    with pytest.raises(ValidationError):
        parse_decision(raw)


def test_decision_event_rejects_null_title_and_naive_datetime() -> None:
    target_id = str(uuid.uuid4())
    for mutation in [
        {
            "operation": "update",
            "resource": "event",
            "target_id": target_id,
            "payload": {"title": None},
        },
        {
            "operation": "create",
            "resource": "event",
            "payload": {"title": "Встреча", "starts_at": "2026-10-15T12:00:00"},
        },
    ]:
        with pytest.raises(ValidationError):
            parse_decision(
                json.dumps(
                    {
                        "reply": "ok",
                        "reads": [],
                        "mutations": [mutation],
                        "clarification": None,
                    }
                )
            )


def test_decision_clarification_is_exclusive() -> None:
    raw = json.dumps(
        {
            "reply": "ok",
            "reads": [],
            "mutations": [
                {
                    "operation": "create",
                    "resource": "task",
                    "payload": {"title": "x"},
                }
            ],
            "clarification": "Уточните",
        }
    )
    with pytest.raises(ValidationError):
        parse_decision(raw)


def test_decision_limits_generated_work() -> None:
    raw = json.dumps(
        {
            "reply": "ok",
            "reads": [{"operation": "list", "resource": "task"}] * 51,
            "mutations": [],
            "clarification": None,
        }
    )
    with pytest.raises(ValidationError):
        parse_decision(raw)


@pytest.mark.asyncio
async def test_request_validation_problem_does_not_echo_sensitive_input() -> None:
    response = await validation_problem(
        None,
        RequestValidationError(
            [
                {
                    "type": "string_too_short",
                    "loc": ("body", "password"),
                    "msg": "String should have at least 8 characters",
                    "input": "secret-value",
                }
            ]
        ),
    )
    body = response.body.decode()
    assert response.status_code == 422
    assert "body.password" in body
    assert "secret-value" not in body


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
    value = User(email="validation@example.test", password_hash="x", timezone="Europe/Moscow")
    session.add(value)
    await session.commit()
    return value


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation",
    [
        CalendarMutation("create", "task", {"title": "x", "status": "invalid"}),
        CalendarMutation("create", "task", {"title": "x", "unknown": "value"}),
        CalendarMutation("delete", "task", {"title": "not-empty"}, uuid.uuid4()),
        CalendarMutation("explode", "task", {}, uuid.uuid4()),
    ],
)
async def test_domain_revalidates_direct_mutations(session, user, mutation) -> None:
    with pytest.raises(CalendarValidationError):
        await CalendarCommandService.execute(session, user, [mutation], origin="rest")
    assert await TaskService.list(session, user) == []


@pytest.mark.asyncio
async def test_invalid_late_mutation_does_not_apply_earlier_mutation(session, user) -> None:
    with pytest.raises(CalendarValidationError):
        await CalendarCommandService.execute(
            session,
            user,
            [
                CalendarMutation("create", "task", {"title": "must roll back"}),
                CalendarMutation("create", "task", {"title": None}),
            ],
            origin="agent",
        )
    assert await TaskService.list(session, user) == []
    assert list((await session.scalars(CalendarOperation.__table__.select())).all()) == []


@pytest.mark.asyncio
async def test_noop_update_does_not_create_history_entry(session, user) -> None:
    created = (
        await CalendarCommandService.execute(
            session,
            user,
            [
                CalendarMutation("create", "task", {"title": "Same"}),
            ],
            origin="rest",
        )
    )[0]
    result = await CalendarCommandService.execute(
        session,
        user,
        [
            CalendarMutation("update", "task", {"title": "Same"}, created.target_id),
        ],
        origin="rest",
    )
    assert result == []
    rows = list((await session.scalars(CalendarOperation.__table__.select())).all())
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_audio_upload_rejects_empty_wrong_type_and_oversize(tmp_path) -> None:
    with pytest.raises(HTTPException) as empty:
        await _save_audio_upload(
            UploadFile(
                filename="empty.webm", file=BytesIO(b""), headers={"content-type": "audio/webm"}
            ),
            directory=tmp_path,
            max_bytes=10,
        )
    assert empty.value.status_code == 422

    with pytest.raises(HTTPException) as wrong_type:
        await _save_audio_upload(
            UploadFile(
                filename="note.txt", file=BytesIO(b"hello"), headers={"content-type": "text/plain"}
            ),
            directory=tmp_path,
            max_bytes=10,
        )
    assert wrong_type.value.status_code == 415

    with pytest.raises(HTTPException) as too_large:
        await _save_audio_upload(
            UploadFile(
                filename="large.webm",
                file=BytesIO(b"01234567890"),
                headers={"content-type": "audio/webm"},
            ),
            directory=tmp_path,
            max_bytes=10,
        )
    assert too_large.value.status_code == 413
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_audio_upload_uses_generated_safe_filename(tmp_path) -> None:
    path = await _save_audio_upload(
        UploadFile(
            filename="../../private.webm",
            file=BytesIO(b"audio"),
            headers={"content-type": "audio/webm"},
        ),
        directory=tmp_path,
        max_bytes=10,
    )
    assert path.parent == tmp_path
    assert path.suffix == ".webm"
    assert path.read_bytes() == b"audio"
