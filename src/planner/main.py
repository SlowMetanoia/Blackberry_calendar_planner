import json
import logging
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from arq import create_pool
from arq.connections import RedisSettings
from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .agent import TranscriptionError, transcribe
from .calendar import (
    CalendarCommandService,
    CalendarMutation,
    CalendarTargetNotFound,
    CalendarValidationError,
    UndoConflict,
)
from .config import get_settings
from .db import Base, engine, get_session
from .llm import verify_llm_connection
from .models import AgentMessage, CalendarOperation, Conversation, Event, MessageStatus, Task, User
from .occurrences import OccurrenceService, occurrence_dict, parse_occurrence_key
from .schemas import (
    AgentInput,
    AgentMessageResponse,
    AuthRequest,
    CalendarOccurrenceResponse,
    CalendarOperationResponse,
    ConversationSummary,
    CursorPage,
    EventCreate,
    EventResponse,
    EventUpdate,
    Page,
    ProblemDetail,
    ProblemFieldError,
    TaskCreate,
    TaskResponse,
    TaskUpdate,
    TimezoneValue,
    TokenResponse,
    TranscriptionResponse,
    UserPreferencesResponse,
    UserPreferencesUpdate,
)
from .search import SearchIndexUnavailable, schedule_calendar_index
from .security import (
    AuthSessionContext,
    create_auth_session,
    current_auth_session,
    current_user,
    hash_password,
    verify_password,
)
from .services import EventService, TaskService, normalize_datetime

AUDIO_DIR = Path("/tmp/planner-audio")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings = get_settings()
    if settings.database_url.startswith("sqlite"):
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
    await verify_llm_connection(settings)
    yield


app = FastAPI(title="Smart Planner API", version="0.1.0", lifespan=lifespan)


def _problem(
    status_code: int,
    detail: str,
    code: str,
    errors: list[ProblemFieldError] | None = None,
) -> JSONResponse:
    titles = {
        401: "Unauthorized",
        404: "Not Found",
        409: "Conflict",
        413: "Content Too Large",
        415: "Unsupported Media Type",
        422: "Validation Error",
    }
    body = ProblemDetail(
        title=titles.get(status_code, "Request Error"),
        status=status_code,
        detail=detail,
        code=code,
        errors=errors,
    )
    return JSONResponse(
        body.model_dump(exclude_none=True),
        status_code=status_code,
        media_type="application/problem+json",
    )


@app.exception_handler(HTTPException)
async def http_problem(_request: Request, exc: HTTPException) -> JSONResponse:
    return _problem(exc.status_code, str(exc.detail), f"http_{exc.status_code}")


@app.exception_handler(RequestValidationError)
async def validation_problem(_request: Request, exc: RequestValidationError) -> JSONResponse:
    errors = [
        ProblemFieldError(
            location=".".join(str(part) for part in item.get("loc", ())),
            message=item.get("msg", "Invalid value"),
            error_type=item.get("type", "validation_error"),
        )
        for item in exc.errors()
    ]
    return _problem(422, "Request validation failed", "validation_error", errors)


@app.exception_handler(CalendarValidationError)
async def calendar_validation_problem(
    _request: Request, exc: CalendarValidationError
) -> JSONResponse:
    return _problem(422, str(exc), "calendar_validation_error")


@app.get("/health", include_in_schema=False)
async def health() -> dict[str, str]:
    return {"status": "ok"}


async def enqueue(message_id: uuid.UUID) -> None:
    pool = await create_pool(RedisSettings.from_dsn(get_settings().redis_url))
    try:
        await pool.enqueue_job("process_message", str(message_id), _job_id=f"message:{message_id}")
    finally:
        await pool.close()


async def _schedule_index(owner_id: uuid.UUID) -> None:
    try:
        await schedule_calendar_index(owner_id, get_settings())
    except SearchIndexUnavailable:
        logger.warning("Calendar index enqueue failed for owner %s", owner_id)


async def _save_audio_upload(
    audio: UploadFile,
    *,
    directory: Path = AUDIO_DIR,
    max_bytes: int,
) -> Path:
    content_type = (audio.content_type or "").lower()
    if not (content_type.startswith("audio/") or content_type == "application/octet-stream"):
        raise HTTPException(415, "Поддерживаются только аудиофайлы")
    suffix = Path(audio.filename or "").suffix.lower()
    if not suffix or len(suffix) > 16 or not suffix[1:].isalnum():
        suffix = ".audio"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{uuid.uuid4()}{suffix}"
    total = 0
    try:
        with path.open("wb") as destination:
            while chunk := await audio.read(1024 * 1024):
                total += len(chunk)
                if total > max_bytes:
                    raise HTTPException(413, "Аудиофайл слишком большой")
                destination.write(chunk)
        if total == 0:
            raise HTTPException(422, "Аудиофайл пуст")
        return path
    except BaseException:
        path.unlink(missing_ok=True)
        raise


async def _transcribe_audio_upload(
    audio: UploadFile,
    *,
    directory: Path = AUDIO_DIR,
    max_bytes: int,
) -> str:
    path = await _save_audio_upload(audio, directory=directory, max_bytes=max_bytes)
    try:
        return await transcribe(str(path))
    finally:
        path.unlink(missing_ok=True)


@app.post("/auth/register", response_model=TokenResponse, status_code=201)
async def register(
    data: AuthRequest, session: AsyncSession = Depends(get_session)
) -> TokenResponse:
    if await session.scalar(select(User).where(User.email == data.email)):
        raise HTTPException(409, "Email is already registered")
    user = User(email=data.email, password_hash=hash_password(data.password))
    session.add(user)
    await session.flush()
    token, _ = await create_auth_session(session, user.id)
    await session.commit()
    return TokenResponse(access_token=token)


@app.post("/auth/login", response_model=TokenResponse)
async def login(data: AuthRequest, session: AsyncSession = Depends(get_session)) -> TokenResponse:
    user = await session.scalar(select(User).where(User.email == data.email))
    if user is None or not verify_password(data.password, user.password_hash):
        raise HTTPException(401, "Invalid credentials")
    token, _ = await create_auth_session(session, user.id)
    await session.commit()
    return TokenResponse(access_token=token)


@app.post("/auth/logout", status_code=204)
async def logout(
    context: AuthSessionContext = Depends(current_auth_session),
    session: AsyncSession = Depends(get_session),
) -> Response:
    await session.delete(context.auth_session)
    await session.commit()
    return Response(status_code=204)


@app.put("/users/me/timezone", response_model=TimezoneValue)
async def set_user_timezone(
    data: TimezoneValue,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> TimezoneValue:
    user.timezone = data.timezone
    await session.commit()
    return data


@app.get("/users/me/preferences", response_model=UserPreferencesResponse)
async def get_user_preferences(
    user: User = Depends(current_user),
) -> UserPreferencesResponse:
    return UserPreferencesResponse.model_validate(user)


@app.patch("/users/me/preferences", response_model=UserPreferencesResponse)
async def update_user_preferences(
    data: UserPreferencesUpdate,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> UserPreferencesResponse:
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(user, field, value)
    await session.commit()
    return UserPreferencesResponse.model_validate(user)


@app.post("/tasks", response_model=TaskResponse, status_code=201)
async def create_task(
    data: TaskCreate,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Task:
    operation = (
        await CalendarCommandService.execute(
            session, user, [CalendarMutation("create", "task", data.model_dump())], origin="rest"
        )
    )[0]
    await session.commit()
    await _schedule_index(user.id)
    return await TaskService.get(session, user, operation.target_id)


@app.get("/tasks", response_model=Page[TaskResponse])
async def list_tasks(
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    deadline_from: datetime | None = None,
    deadline_to: datetime | None = None,
    status: Literal["open", "completed"] | None = None,
    deadline_presence: Literal["dated", "undated", "any"] = "any",
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Page[TaskResponse]:
    if (
        deadline_from
        and deadline_to
        and normalize_datetime(deadline_from, user) >= normalize_datetime(deadline_to, user)
    ):
        raise HTTPException(422, "deadline_from must be earlier than deadline_to")
    items, total = await TaskService.page(
        session,
        user,
        limit=limit,
        offset=offset,
        from_datetime=deadline_from,
        to_datetime=deadline_to,
        status=status,
        deadline_presence=deadline_presence,
    )
    return Page(items=items, total=total, limit=limit, offset=offset)


@app.get("/tasks/{task_id}", response_model=TaskResponse)
async def get_task(
    task_id: uuid.UUID,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Task:
    task = await TaskService.get(session, user, task_id)
    if task is None:
        raise HTTPException(404, "Task not found")
    return task


@app.patch("/tasks/{task_id}", response_model=TaskResponse)
async def update_task(
    task_id: uuid.UUID,
    data: TaskUpdate,
    effective_from_occurrence_key: str | None = None,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Task:
    try:
        await CalendarCommandService.execute(
            session,
            user,
            [
                CalendarMutation(
                    "update",
                    "task",
                    data.model_dump(exclude_unset=True),
                    task_id,
                    effective_from_occurrence_key=effective_from_occurrence_key,
                )
            ],
            origin="rest",
        )
    except CalendarTargetNotFound:
        raise HTTPException(404, "Task not found")
    await session.commit()
    await _schedule_index(user.id)
    return await TaskService.get(session, user, task_id)


@app.delete("/tasks/{task_id}", status_code=204)
async def delete_task(
    task_id: uuid.UUID,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    try:
        await CalendarCommandService.execute(
            session, user, [CalendarMutation("delete", "task", {}, task_id)], origin="rest"
        )
    except CalendarTargetNotFound:
        raise HTTPException(404, "Task not found")
    await session.commit()
    await _schedule_index(user.id)


@app.post("/events", response_model=EventResponse, status_code=201)
async def create_event(
    data: EventCreate,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Event:
    operation = (
        await CalendarCommandService.execute(
            session, user, [CalendarMutation("create", "event", data.model_dump())], origin="rest"
        )
    )[0]
    await session.commit()
    await _schedule_index(user.id)
    return await EventService.get(session, user, operation.target_id)


@app.get("/events", response_model=Page[EventResponse])
async def list_events(
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    starts_at_from: datetime | None = None,
    starts_at_to: datetime | None = None,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Page[EventResponse]:
    if (
        starts_at_from
        and starts_at_to
        and normalize_datetime(starts_at_from, user) >= normalize_datetime(starts_at_to, user)
    ):
        raise HTTPException(422, "starts_at_from must be earlier than starts_at_to")
    items, total = await EventService.page(
        session,
        user,
        limit=limit,
        offset=offset,
        from_datetime=starts_at_from,
        to_datetime=starts_at_to,
    )
    return Page(items=items, total=total, limit=limit, offset=offset)


@app.get("/events/{event_id}", response_model=EventResponse)
async def get_event(
    event_id: uuid.UUID,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Event:
    event = await EventService.get(session, user, event_id)
    if event is None:
        raise HTTPException(404, "Event not found")
    return event


@app.patch("/events/{event_id}", response_model=EventResponse)
async def update_event(
    event_id: uuid.UUID,
    data: EventUpdate,
    effective_from_occurrence_key: str | None = None,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Event:
    try:
        await CalendarCommandService.execute(
            session,
            user,
            [
                CalendarMutation(
                    "update",
                    "event",
                    data.model_dump(exclude_unset=True),
                    event_id,
                    effective_from_occurrence_key=effective_from_occurrence_key,
                )
            ],
            origin="rest",
        )
    except CalendarTargetNotFound:
        raise HTTPException(404, "Event not found")
    await session.commit()
    await _schedule_index(user.id)
    return await EventService.get(session, user, event_id)


@app.delete("/events/{event_id}", status_code=204)
async def delete_event(
    event_id: uuid.UUID,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    try:
        await CalendarCommandService.execute(
            session, user, [CalendarMutation("delete", "event", {}, event_id)], origin="rest"
        )
    except CalendarTargetNotFound:
        raise HTTPException(404, "Event not found")
    await session.commit()
    await _schedule_index(user.id)


@app.get("/calendar/occurrences", response_model=CursorPage[CalendarOccurrenceResponse])
async def list_calendar_occurrences(
    resource: Literal["all", "task", "event"] = "all",
    series_id: uuid.UUID | None = None,
    from_datetime: datetime | None = Query(default=None, alias="from"),
    to_datetime: datetime | None = Query(default=None, alias="to"),
    status: Literal["open", "completed"] | None = None,
    limit: int = Query(100, ge=1, le=100),
    cursor: str | None = Query(default=None, max_length=4096),
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> CursorPage[CalendarOccurrenceResponse]:
    if (
        from_datetime
        and to_datetime
        and normalize_datetime(from_datetime, user) >= normalize_datetime(to_datetime, user)
    ):
        raise HTTPException(422, "from must be earlier than to")
    try:
        page = await OccurrenceService.page(
            session,
            user,
            resource=resource,
            series_id=series_id,
            from_datetime=from_datetime,
            to_datetime=to_datetime,
            status=status,
            limit=limit,
            cursor=cursor,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return CursorPage(
        items=[
            CalendarOccurrenceResponse.model_validate(occurrence_dict(item)) for item in page.items
        ],
        total=page.total,
        has_more=page.has_more,
        next_cursor=page.next_cursor,
    )


async def _update_occurrence(
    resource: Literal["task", "event"],
    target_id: uuid.UUID,
    occurrence_key: str,
    payload: dict,
    user: User,
    session: AsyncSession,
) -> CalendarOccurrenceResponse:
    if {"recurrence", "recurrence_timezone"} & payload.keys():
        raise HTTPException(422, "recurrence can only be changed for a series")
    try:
        operation = (
            await CalendarCommandService.execute(
                session,
                user,
                [
                    CalendarMutation(
                        "update",
                        resource,
                        payload,
                        target_id,
                        scope="occurrence",
                        occurrence_key=occurrence_key,
                    )
                ],
                origin="rest",
            )
        )[0]
    except CalendarTargetNotFound as exc:
        raise HTTPException(404, "Calendar occurrence not found") from exc
    await session.commit()
    await _schedule_index(user.id)
    data = operation.after_state or {}
    schedule_field = "deadline" if resource == "task" else "starts_at"
    scheduled_at = data[schedule_field]
    return CalendarOccurrenceResponse(
        resource=resource,
        series_id=target_id,
        occurrence_key=occurrence_key,
        original_at=parse_occurrence_key(occurrence_key)[1],
        scheduled_at=scheduled_at,
        recurring=True,
        data=data,
    )


async def _delete_occurrence(
    resource: Literal["task", "event"],
    target_id: uuid.UUID,
    occurrence_key: str,
    user: User,
    session: AsyncSession,
) -> None:
    try:
        await CalendarCommandService.execute(
            session,
            user,
            [
                CalendarMutation(
                    "delete",
                    resource,
                    {},
                    target_id,
                    scope="occurrence",
                    occurrence_key=occurrence_key,
                )
            ],
            origin="rest",
        )
    except CalendarTargetNotFound as exc:
        raise HTTPException(404, "Calendar occurrence not found") from exc
    await session.commit()


@app.patch(
    "/tasks/{task_id}/occurrences/{occurrence_key}", response_model=CalendarOccurrenceResponse
)
async def update_task_occurrence(
    task_id: uuid.UUID,
    occurrence_key: str,
    data: TaskUpdate,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> CalendarOccurrenceResponse:
    return await _update_occurrence(
        "task", task_id, occurrence_key, data.model_dump(exclude_unset=True), user, session
    )


@app.delete("/tasks/{task_id}/occurrences/{occurrence_key}", status_code=204)
async def delete_task_occurrence(
    task_id: uuid.UUID,
    occurrence_key: str,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    await _delete_occurrence("task", task_id, occurrence_key, user, session)


@app.patch(
    "/events/{event_id}/occurrences/{occurrence_key}", response_model=CalendarOccurrenceResponse
)
async def update_event_occurrence(
    event_id: uuid.UUID,
    occurrence_key: str,
    data: EventUpdate,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> CalendarOccurrenceResponse:
    return await _update_occurrence(
        "event", event_id, occurrence_key, data.model_dump(exclude_unset=True), user, session
    )


@app.delete("/events/{event_id}/occurrences/{occurrence_key}", status_code=204)
async def delete_event_occurrence(
    event_id: uuid.UUID,
    occurrence_key: str,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    await _delete_occurrence("event", event_id, occurrence_key, user, session)


@app.get("/calendar/history", response_model=Page[CalendarOperationResponse])
async def calendar_history(
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Page[CalendarOperationResponse]:
    condition = CalendarOperation.owner_id == user.id
    operations = list(
        (
            await session.scalars(
                select(CalendarOperation)
                .where(condition)
                .order_by(CalendarOperation.sequence.desc())
                .offset(offset)
                .limit(limit)
            )
        ).all()
    )
    total = int(
        await session.scalar(select(func.count()).select_from(CalendarOperation).where(condition))
        or 0
    )
    return Page(
        items=[CalendarOperationResponse.from_operation(item) for item in operations],
        total=total,
        limit=limit,
        offset=offset,
    )


@app.post(
    "/calendar/history/{operation_id}/undo",
    response_model=CalendarOperationResponse,
    status_code=201,
)
async def undo_calendar_operation(
    operation_id: uuid.UUID,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> CalendarOperationResponse | JSONResponse:
    try:
        operation = await CalendarCommandService.undo(session, user, operation_id)
    except CalendarTargetNotFound:
        return _problem(404, "Операция не найдена", "operation_not_found")
    except UndoConflict as exc:
        return _problem(409, str(exc), "undo_conflict")
    await session.commit()
    await _schedule_index(user.id)
    await session.refresh(operation)
    return CalendarOperationResponse.from_operation(operation)


async def _new_message(
    user: User,
    session: AsyncSession,
    *,
    text: str | None,
    audio_path: str | None,
    conversation_id: uuid.UUID | None,
    idempotency_key: str | None,
) -> AgentMessage:
    if idempotency_key:
        existing = await session.scalar(
            select(AgentMessage).where(
                AgentMessage.owner_id == user.id, AgentMessage.idempotency_key == idempotency_key
            )
        )
        if existing:
            if existing.status == MessageStatus.queued:
                await enqueue(existing.id)
            return existing
    conversation_id = conversation_id or uuid.uuid4()
    conversation = await session.scalar(
        select(Conversation).where(Conversation.id == conversation_id).with_for_update()
    )
    if conversation is None:
        conversation = Conversation(id=conversation_id, owner_id=user.id)
        session.add(conversation)
        await session.flush()
    elif conversation.owner_id != user.id:
        raise HTTPException(404, "Conversation not found")
    conversation.last_activity_at = datetime.now(UTC)
    last = await session.scalar(
        select(AgentMessage.sequence)
        .where(AgentMessage.conversation_id == conversation_id)
        .order_by(AgentMessage.sequence.desc())
        .limit(1)
    )
    message = AgentMessage(
        owner_id=user.id,
        conversation_id=conversation_id,
        sequence=(last or 0) + 1,
        input_text=text,
        audio_path=audio_path,
        idempotency_key=idempotency_key,
        status=MessageStatus.queued,
    )
    session.add(message)
    await session.commit()
    await session.refresh(message)
    await enqueue(message.id)
    return message


@app.get("/agent/conversations", response_model=Page[ConversationSummary])
async def list_conversations(
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Page[ConversationSummary]:
    first_text = (
        select(AgentMessage.input_text)
        .where(
            AgentMessage.conversation_id == Conversation.id,
            AgentMessage.owner_id == user.id,
            AgentMessage.input_text.is_not(None),
            AgentMessage.input_text != "",
        )
        .order_by(AgentMessage.sequence)
        .limit(1)
        .scalar_subquery()
    )
    rows = (
        await session.execute(
            select(Conversation, first_text.label("preview"))
            .where(Conversation.owner_id == user.id)
            .order_by(Conversation.last_activity_at.desc(), Conversation.id)
            .offset(offset)
            .limit(limit)
        )
    ).all()
    total = int(
        await session.scalar(
            select(func.count()).select_from(Conversation).where(Conversation.owner_id == user.id)
        )
        or 0
    )
    items = [
        ConversationSummary(
            id=conversation.id,
            preview=((preview or "Голосовое сообщение").strip()[:80] or "Новый диалог"),
            created_at=conversation.created_at,
            last_activity_at=conversation.last_activity_at,
        )
        for conversation, preview in rows
    ]
    return Page(items=items, total=total, limit=limit, offset=offset)


async def _message_response(message: AgentMessage, session: AsyncSession) -> AgentMessageResponse:
    payload = {}
    if message.result:
        try:
            payload = json.loads(message.result)
        except json.JSONDecodeError:
            payload = {"reply": message.result}
    display_items = payload.get("display_items")
    if not isinstance(display_items, list):
        display_items = payload.get("reads", [])
    unique_display_items = []
    seen_display_items = set()
    if isinstance(display_items, list):
        for item in display_items:
            if not isinstance(item, dict):
                continue
            resource = item.get("resource")
            try:
                ident = uuid.UUID(str(item.get("id")))
            except (TypeError, ValueError, AttributeError):
                continue
            if resource not in {"task", "event"}:
                continue
            key = (resource, ident)
            if key in seen_display_items:
                continue
            seen_display_items.add(key)
            unique_display_items.append(item)
    return AgentMessageResponse(
        id=message.id,
        conversation_id=message.conversation_id,
        sequence=message.sequence,
        input_text=message.input_text,
        status=message.status,
        error=message.error,
        reply=payload.get("reply"),
        diagnostics=payload.get("diagnostics", {}),
        display_items=unique_display_items,
        operations=payload.get("operations", []),
        requires_new_conversation=payload.get("requires_new_conversation", False),
        created_at=message.created_at,
    )


@app.post("/agent/messages", response_model=AgentMessageResponse, status_code=202)
async def submit_text_message(
    data: AgentInput,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
    idempotency_key: str | None = Header(default=None, min_length=1, max_length=255),
) -> AgentMessageResponse:
    message = await _new_message(
        user,
        session,
        text=data.text,
        audio_path=None,
        conversation_id=data.conversation_id,
        idempotency_key=idempotency_key,
    )
    return await _message_response(message, session)


@app.post("/agent/messages/audio", response_model=AgentMessageResponse, status_code=202)
async def submit_audio_message(
    audio: UploadFile = File(...),
    conversation_id: uuid.UUID | None = None,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
    idempotency_key: str | None = Header(default=None, min_length=1, max_length=255),
) -> AgentMessageResponse:
    audio_path = await _save_audio_upload(
        audio,
        max_bytes=get_settings().audio_max_upload_bytes,
    )
    message = await _new_message(
        user,
        session,
        text=None,
        audio_path=str(audio_path),
        conversation_id=conversation_id,
        idempotency_key=idempotency_key,
    )
    return await _message_response(message, session)


@app.post("/audio/transcriptions", response_model=TranscriptionResponse)
async def transcribe_audio(
    audio: UploadFile = File(...),
    _user: User = Depends(current_user),
) -> TranscriptionResponse:
    try:
        text = await _transcribe_audio_upload(
            audio,
            max_bytes=get_settings().audio_max_upload_bytes,
        )
    except TranscriptionError as exc:
        raise HTTPException(502, str(exc)) from exc
    except RuntimeError as exc:
        logger.warning("Open-air transcription unavailable: %s", type(exc).__name__)
        raise HTTPException(503, "Сервис распознавания речи временно недоступен") from exc
    return TranscriptionResponse(text=text)


@app.get("/agent/messages/{message_id}", response_model=AgentMessageResponse)
async def get_message(
    message_id: uuid.UUID,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> AgentMessageResponse:
    message = await session.scalar(
        select(AgentMessage).where(AgentMessage.id == message_id, AgentMessage.owner_id == user.id)
    )
    if message is None:
        raise HTTPException(404, "Message not found")
    return await _message_response(message, session)


@app.get(
    "/agent/conversations/{conversation_id}/messages", response_model=Page[AgentMessageResponse]
)
async def conversation_messages(
    conversation_id: uuid.UUID,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Page[AgentMessageResponse]:
    base = (AgentMessage.conversation_id == conversation_id, AgentMessage.owner_id == user.id)
    messages = list(
        (
            await session.scalars(
                select(AgentMessage)
                .where(*base)
                .order_by(AgentMessage.sequence)
                .offset(offset)
                .limit(limit)
            )
        ).all()
    )
    total = int(
        await session.scalar(select(func.count()).select_from(AgentMessage).where(*base)) or 0
    )
    items = [await _message_response(message, session) for message in messages]
    return Page(items=items, total=total, limit=limit, offset=offset)
