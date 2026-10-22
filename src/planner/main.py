import asyncio
import hashlib
import json
import logging
import secrets
import tempfile
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

import httpx
from arq import create_pool
from arq.connections import RedisSettings
from fastapi import (
    Depends,
    FastAPI,
    File,
    Header,
    HTTPException,
    Query,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.websockets import WebSocketDisconnected

from .agent import TranscriptionError, transcribe
from .calendar import (
    CalendarCommandService,
    CalendarMutation,
    CalendarTargetNotFound,
    CalendarValidationError,
    UndoConflict,
)
from .collisions import collision_report
from .config import get_settings
from .db import Base, SessionLocal, engine, get_session
from .llm import verify_llm_connection
from .models import (
    AgentMessage,
    CalendarOperation,
    Conversation,
    Event,
    MessageStatus,
    Notification,
    PushSubscription,
    Reminder,
    Task,
    User,
)
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
    EventMutationResponse,
    EventOccurrenceMutationResponse,
    EventResponse,
    EventUpdate,
    NotificationResponse,
    Page,
    ProblemDetail,
    ProblemFieldError,
    PushConfigResponse,
    PushSubscriptionPayload,
    ReminderCreate,
    ReminderResponse,
    ReminderUpdate,
    TaskCreate,
    TaskResponse,
    TaskUpdate,
    TimezoneValue,
    TokenResponse,
    TranscriptionResponse,
    UserPreferencesResponse,
    UserPreferencesUpdate,
)
from .search import (
    SearchIndexUnavailable,
    schedule_calendar_index,
)
from .security import (
    AuthSessionContext,
    create_auth_session,
    current_auth_session,
    current_user,
    hash_password,
    verify_password,
)
from .services import EventService, TaskService, normalize_datetime
from .voice import (
    HandsFreeProtocolError,
    VoiceConversation,
    pcm16_wave_bytes,
    split_speech_text,
)

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


@app.post("/events", response_model=EventMutationResponse, status_code=201)
async def create_event(
    data: EventCreate,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> EventMutationResponse:
    operation = (
        await CalendarCommandService.execute(
            session, user, [CalendarMutation("create", "event", data.model_dump())], origin="rest"
        )
    )[0]
    await session.commit()
    await _schedule_index(user.id)
    report = await collision_report(session, user, [operation])
    event = await EventService.get(session, user, operation.target_id)
    return EventMutationResponse.model_validate(event).model_copy(
        update={"collision_report": report}
    )


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


@app.patch("/events/{event_id}", response_model=EventMutationResponse)
async def update_event(
    event_id: uuid.UUID,
    data: EventUpdate,
    effective_from_occurrence_key: str | None = None,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> EventMutationResponse:
    try:
        operations = await CalendarCommandService.execute(
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
    report = await collision_report(session, user, operations)
    event = await EventService.get(session, user, event_id)
    return EventMutationResponse.model_validate(event).model_copy(
        update={"collision_report": report}
    )


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


@app.post("/reminders", response_model=ReminderResponse, status_code=201)
async def create_reminder(
    data: ReminderCreate,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Reminder:
    operation = (
        await CalendarCommandService.execute(
            session,
            user,
            [CalendarMutation("create", "reminder", data.model_dump())],
            origin="rest",
        )
    )[0]
    await session.commit()
    await _schedule_index(user.id)
    return await session.get(Reminder, operation.target_id)


@app.get("/reminders", response_model=Page[ReminderResponse])
async def list_reminders(
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    status: Literal["active", "fired", "cancelled"] | None = None,
    remind_from: datetime | None = None,
    remind_to: datetime | None = None,
    linked_resource: Literal["task", "event"] | None = None,
    linked_id: uuid.UUID | None = None,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Page[ReminderResponse]:
    conditions = [Reminder.owner_id == user.id]
    if remind_from and remind_to and remind_from >= remind_to:
        raise HTTPException(422, "remind_from must be earlier than remind_to")
    if linked_resource:
        conditions.append(Reminder.linked_resource == linked_resource)
    if linked_id:
        conditions.append(Reminder.linked_id == linked_id)
    if status:
        conditions.append(Reminder.status == status)
    if remind_from:
        conditions.append(Reminder.remind_at >= normalize_datetime(remind_from, user))
    if remind_to:
        conditions.append(Reminder.remind_at < normalize_datetime(remind_to, user))
    items = list(
        (
            await session.scalars(
                select(Reminder)
                .where(*conditions)
                .order_by(Reminder.remind_at, Reminder.id)
                .offset(offset)
                .limit(limit)
            )
        ).all()
    )
    total = int(
        await session.scalar(select(func.count()).select_from(Reminder).where(*conditions)) or 0
    )
    return Page(items=items, total=total, limit=limit, offset=offset)


@app.get("/reminders/{reminder_id}", response_model=ReminderResponse)
async def get_reminder(
    reminder_id: uuid.UUID,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Reminder:
    reminder = await session.scalar(
        select(Reminder).where(Reminder.id == reminder_id, Reminder.owner_id == user.id)
    )
    if reminder is None:
        raise HTTPException(404, "Reminder not found")
    return reminder


@app.patch("/reminders/{reminder_id}", response_model=ReminderResponse)
async def update_reminder(
    reminder_id: uuid.UUID,
    data: ReminderUpdate,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Reminder:
    try:
        await CalendarCommandService.execute(
            session,
            user,
            [
                CalendarMutation(
                    "update", "reminder", data.model_dump(exclude_unset=True), reminder_id
                )
            ],
            origin="rest",
        )
    except CalendarTargetNotFound as exc:
        raise HTTPException(404, "Reminder not found") from exc
    await session.commit()
    await _schedule_index(user.id)
    return await session.get(Reminder, reminder_id)


@app.delete("/reminders/{reminder_id}", status_code=204)
async def delete_reminder(
    reminder_id: uuid.UUID,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    try:
        await CalendarCommandService.execute(
            session, user, [CalendarMutation("delete", "reminder", {}, reminder_id)], origin="rest"
        )
    except CalendarTargetNotFound as exc:
        raise HTTPException(404, "Reminder not found") from exc
    await session.commit()
    await _schedule_index(user.id)


@app.get("/notifications", response_model=Page[NotificationResponse])
async def list_notifications(
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    unread: bool = False,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Page[NotificationResponse]:
    conditions = [Notification.owner_id == user.id]
    if unread:
        conditions.append(Notification.read_at.is_(None))
    items = list(
        (
            await session.scalars(
                select(Notification)
                .where(*conditions)
                .order_by(Notification.created_at.desc())
                .offset(offset)
                .limit(limit)
            )
        ).all()
    )
    total = int(
        await session.scalar(select(func.count()).select_from(Notification).where(*conditions)) or 0
    )
    return Page(items=items, total=total, limit=limit, offset=offset)


@app.patch("/notifications/{notification_id}/read", response_model=NotificationResponse)
async def mark_notification_read(
    notification_id: uuid.UUID,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Notification:
    notification = await session.scalar(
        select(Notification).where(
            Notification.id == notification_id, Notification.owner_id == user.id
        )
    )
    if notification is None:
        raise HTTPException(404, "Notification not found")
    notification.read_at = datetime.now(UTC)
    await session.commit()
    return notification


@app.post("/notifications/read-all", status_code=204)
async def mark_all_notifications_read(
    user: User = Depends(current_user), session: AsyncSession = Depends(get_session)
) -> None:

    await session.execute(
        update(Notification)
        .where(Notification.owner_id == user.id, Notification.read_at.is_(None))
        .values(read_at=datetime.now(UTC))
    )
    await session.commit()


@app.delete("/notifications/{notification_id}", status_code=204)
async def delete_notification(
    notification_id: uuid.UUID,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    notification = await session.scalar(
        select(Notification).where(
            Notification.id == notification_id, Notification.owner_id == user.id
        )
    )
    if notification is None:
        raise HTTPException(404, "Notification not found")
    await session.delete(notification)
    await session.commit()


@app.get("/notifications/push/config", response_model=PushConfigResponse)
async def push_config() -> PushConfigResponse:
    settings = get_settings()
    return PushConfigResponse(
        enabled=bool(
            settings.web_push_vapid_public_key
            and settings.web_push_vapid_private_key
            and settings.web_push_vapid_subject
        ),
        public_key=settings.web_push_vapid_public_key,
    )


@app.put("/notifications/push/subscription", status_code=204)
async def upsert_push_subscription(
    data: PushSubscriptionPayload,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    await session.execute(
        update(PushSubscription)
        .where(PushSubscription.endpoint == data.endpoint, PushSubscription.owner_id != user.id)
        .values(active=False)
    )
    subscription = await session.scalar(
        select(PushSubscription).where(
            PushSubscription.owner_id == user.id, PushSubscription.endpoint == data.endpoint
        )
    )
    if subscription is None:
        subscription = PushSubscription(owner_id=user.id, **data.model_dump())
        session.add(subscription)
    else:
        subscription.p256dh = data.p256dh
        subscription.auth = data.auth
        subscription.active = True
    await session.commit()


@app.delete("/notifications/push/subscription", status_code=204)
async def delete_push_subscription(
    data: PushSubscriptionPayload,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    subscription = await session.scalar(
        select(PushSubscription).where(
            PushSubscription.owner_id == user.id, PushSubscription.endpoint == data.endpoint
        )
    )
    if subscription is not None:
        subscription.active = False
        await session.commit()


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
    response_type = (
        EventOccurrenceMutationResponse if resource == "event" else CalendarOccurrenceResponse
    )
    extra = (
        {"collision_report": await collision_report(session, user, [operation])}
        if resource == "event"
        else {}
    )
    return response_type(
        resource=resource,
        series_id=target_id,
        occurrence_key=occurrence_key,
        original_at=parse_occurrence_key(occurrence_key)[1],
        scheduled_at=scheduled_at,
        recurring=True,
        data=data,
        **extra,
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
    "/events/{event_id}/occurrences/{occurrence_key}",
    response_model=EventOccurrenceMutationResponse,
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
            if resource not in {"task", "event", "reminder"}:
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
        speech_text=message.speech_text,
        collision_notices=payload.get("collision_notices", []),
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


def _voice_ticket_key(ticket: str) -> str:
    return f"voice-ticket:{hashlib.sha256(ticket.encode()).hexdigest()}"


async def _redis_pool():
    return await create_pool(RedisSettings.from_dsn(get_settings().redis_url))


@app.get("/voice/capabilities")
async def voice_capabilities(_user: User = Depends(current_user)) -> dict:
    settings = get_settings()
    return {
        "stt": {"configured": bool(settings.stt_base_url), "sample_rate": 16_000},
        "tts": {
            "configured": bool(settings.tts_base_url),
            "model": settings.tts_model,
            "voices": ["aidar", "baya", "kseniya", "xenia", "eugene"],
            "sample_rate": 24_000,
        },
    }


@app.post("/voice/session-tickets", status_code=201)
async def create_voice_session_ticket(user: User = Depends(current_user)) -> dict:
    settings = get_settings()
    ticket = secrets.token_urlsafe(32)
    pool = await _redis_pool()
    try:
        await pool.setex(
            _voice_ticket_key(ticket),
            settings.voice_ticket_ttl_seconds,
            str(user.id),
        )
    finally:
        await pool.close()
    return {"ticket": ticket, "expires_in": settings.voice_ticket_ttl_seconds}


async def _consume_voice_ticket(ticket: str) -> uuid.UUID | None:
    pool = await _redis_pool()
    try:
        raw = await pool.execute_command("GETDEL", _voice_ticket_key(ticket))
    finally:
        await pool.close()
    if raw is None:
        return None
    try:
        return uuid.UUID(raw.decode() if isinstance(raw, bytes) else str(raw))
    except ValueError:
        return None


async def _tts_audio(text: str, *, voice: str, speed: float) -> bytes:
    settings = get_settings()
    if not settings.tts_base_url:
        raise RuntimeError("TTS is not configured")
    headers = {"Content-Type": "application/json"}
    if settings.tts_api_key:
        headers["Authorization"] = f"Bearer {settings.tts_api_key}"
    async with httpx.AsyncClient(timeout=settings.tts_request_timeout_seconds) as client:
        response = await client.post(
            f"{settings.tts_base_url.rstrip('/')}/v1/audio/speech",
            headers=headers,
            json={"model": settings.tts_model, "voice": voice, "speed": speed, "input": text},
        )
        response.raise_for_status()
        return response.content


async def _transcribe_pcm(pcm: bytes) -> str:
    path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as output:
            output.write(pcm16_wave_bytes(pcm))
            path = Path(output.name)
        return await transcribe(str(path))
    finally:
        if path is not None:
            path.unlink(missing_ok=True)


async def _wait_for_terminal_message(message_id: uuid.UUID) -> AgentMessage:
    deadline = asyncio.get_running_loop().time() + get_settings().voice_terminal_wait_seconds
    while asyncio.get_running_loop().time() < deadline:
        async with SessionLocal() as session:
            message = await session.get(AgentMessage, message_id)
            if message is not None and message.status in {
                MessageStatus.completed,
                MessageStatus.needs_clarification,
                MessageStatus.failed,
            }:
                return message
        await asyncio.sleep(0.5)
    raise TimeoutError("voice turn timed out")


async def _send_tts(websocket: WebSocket, user: User, message: AgentMessage) -> bool:
    if not user.voice_output_enabled or not message.speech_text:
        return False
    chunks = split_speech_text(message.speech_text)
    audio_sent = False
    try:
        for index, phrase in enumerate(chunks):
            audio = await _tts_audio(phrase, voice=user.tts_voice, speed=user.tts_speed)
            await websocket.send_json(
                {"type": "tts_phrase", "index": index, "count": len(chunks), "text": phrase}
            )
            await websocket.send_bytes(audio)
            audio_sent = True
    except (httpx.HTTPError, RuntimeError):
        logger.warning("TTS unavailable for message %s", message.id)
        await websocket.send_json(
            {"type": "tts_unavailable", "message": "Голосовой вывод временно недоступен"}
        )
    return audio_sent


async def _finish_tts(websocket: WebSocket, user: User, message: AgentMessage) -> None:
    event_type = (
        "playback_ready" if await _send_tts(websocket, user, message) else "playback_skipped"
    )
    await websocket.send_json({"type": event_type})


@app.websocket("/voice/session")
async def voice_session(websocket: WebSocket, ticket: str) -> None:
    owner_id = await _consume_voice_ticket(ticket)
    if owner_id is None:
        await websocket.close(code=4401, reason="Invalid or expired voice ticket")
        return
    await websocket.accept()
    settings = get_settings()
    state = VoiceConversation(
        max_pcm_bytes=settings.voice_max_pcm_bytes,
        max_duration_seconds=settings.voice_max_duration_seconds,
    )
    conversation_id: uuid.UUID | None = None
    utterance_phase: Literal["wake", "command"] | None = None
    await websocket.send_json({"type": "state", "state": "armed"})
    try:
        while True:
            incoming = await websocket.receive()
            if incoming.get("type") == "websocket.disconnect":
                return
            if incoming.get("bytes") is not None:
                state.add_pcm(incoming["bytes"])
                continue
            raw = incoming.get("text")
            if raw is None:
                continue
            event = json.loads(raw)
            event_type = event.get("type")
            if event_type == "start":
                state.activate()
                await websocket.send_json({"type": "state", "state": "ready"})
            elif event_type == "utterance_start":
                logger.info("Voice utterance started for owner %s", owner_id)
                utterance_phase = "command" if state.active else "wake"
                state.begin_utterance(sample_rate=int(event.get("sample_rate", 16_000)))
                await websocket.send_json(
                    {"type": "state", "state": "capturing", "phase": utterance_phase}
                )
            elif event_type == "utterance_end":
                logger.info("Voice utterance ended for owner %s", owner_id)
                if utterance_phase is None:
                    raise HandsFreeProtocolError("voice utterance was not started")
                phase = utterance_phase
                state.start_turn()
                await websocket.send_json({"type": "state", "state": "processing", "phase": phase})
                try:
                    transcript = await _transcribe_pcm(state.finish_utterance())
                    logger.info("Voice utterance transcribed for owner %s", owner_id)
                    await websocket.send_json({"type": "transcript", "text": transcript})
                    command = state.accept_transcript(transcript)
                    if command is None:
                        await websocket.send_json(
                            {"type": "state", "state": "ready" if state.active else "armed"}
                        )
                        continue
                    if not command:
                        await websocket.send_json({"type": "state", "state": "ready"})
                        continue
                    async with SessionLocal() as session:
                        user = await session.get(User, owner_id)
                        if user is None:
                            await websocket.close(code=4401)
                            return
                        message = await _new_message(
                            user,
                            session,
                            text=command,
                            audio_path=None,
                            conversation_id=conversation_id,
                            idempotency_key=None,
                        )
                        conversation_id = message.conversation_id
                        queued_response = await _message_response(message, session)
                    await websocket.send_json(
                        {"type": "message", "message": queued_response.model_dump(mode="json")}
                    )
                    terminal = await _wait_for_terminal_message(message.id)
                    async with SessionLocal() as session:
                        response = await _message_response(terminal, session)
                        user = await session.get(User, owner_id)
                    await websocket.send_json(
                        {"type": "message", "message": response.model_dump(mode="json")}
                    )
                    await websocket.send_json({"type": "state", "state": "speaking"})
                    if user is not None:
                        await _finish_tts(websocket, user, terminal)
                    else:
                        await websocket.send_json({"type": "playback_skipped"})
                finally:
                    utterance_phase = None
                    state.finish_turn()
            elif event_type == "playback_complete":
                await websocket.send_json(
                    {"type": "state", "state": "ready" if state.active else "armed"}
                )
            elif event_type == "repeat":
                async with SessionLocal() as session:
                    message = await session.scalar(
                        select(AgentMessage).where(
                            AgentMessage.id == uuid.UUID(str(event.get("message_id"))),
                            AgentMessage.owner_id == owner_id,
                        )
                    )
                    user = await session.get(User, owner_id)
                if message is None or user is None or not message.speech_text:
                    await websocket.send_json({"type": "error", "message": "Ответ не найден"})
                else:
                    await _finish_tts(websocket, user, message)
            elif event_type == "stop":
                state.active = False
                utterance_phase = None
                await websocket.send_json({"type": "state", "state": "armed"})
    except HandsFreeProtocolError as exc:
        await websocket.send_json({"type": "error", "message": str(exc)})
        await websocket.close(code=1009)
    except (WebSocketDisconnect, WebSocketDisconnected, json.JSONDecodeError):
        return


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
