import json
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from arq import create_pool
from arq.connections import RedisSettings
from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import get_settings
from .db import Base, engine, get_session
from .models import AgentMessage, Conversation, Event, MessageStatus, Task, User, ActionPlan, PlannedAction, ActionStatus
from .llm import verify_llm_connection
from .plans import PlanService
from .services import TaskService, EventService
from .schemas import (
    ActionCommandResponse, ActionPlanResponse, AgentInput, AgentMessageResponse, AuthRequest,
    EventCreate, EventResponse, EventUpdate, Page, ProblemDetail, TaskCreate, TaskResponse,
    TaskUpdate, TimezoneValue, TokenResponse,
)
from .security import create_token, current_user, hash_password, verify_password

AUDIO_DIR = Path("/tmp/planner-audio")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings = get_settings()
    if settings.database_url.startswith("sqlite"):
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
    await verify_llm_connection(settings)
    yield


app = FastAPI(title="Smart Planner API", version="0.1.0", lifespan=lifespan)


def _problem(status_code: int, detail: str, code: str) -> JSONResponse:
    titles = {401: "Unauthorized", 404: "Not Found", 409: "Conflict", 422: "Validation Error"}
    body = ProblemDetail(
        title=titles.get(status_code, "Request Error"), status=status_code,
        detail=detail, code=code,
    )
    return JSONResponse(body.model_dump(), status_code=status_code,
                        media_type="application/problem+json")


@app.exception_handler(HTTPException)
async def http_problem(_request: Request, exc: HTTPException) -> JSONResponse:
    return _problem(exc.status_code, str(exc.detail), f"http_{exc.status_code}")


@app.exception_handler(RequestValidationError)
async def validation_problem(_request: Request, exc: RequestValidationError) -> JSONResponse:
    return _problem(422, str(exc.errors()), "validation_error")


@app.get("/health", include_in_schema=False)
async def health() -> dict[str, str]:
    return {"status": "ok"}


async def enqueue(message_id: uuid.UUID) -> None:
    pool = await create_pool(RedisSettings.from_dsn(get_settings().redis_url))
    try:
        await pool.enqueue_job("process_message", str(message_id), _job_id=f"message:{message_id}")
    finally:
        await pool.close()


async def enqueue_actions(action_ids: list[uuid.UUID]) -> None:
    pool = await create_pool(RedisSettings.from_dsn(get_settings().redis_url))
    try:
        for action_id in action_ids:
            await pool.enqueue_job(
                "execute_plan_action", str(action_id), _job_id=f"action:{action_id}"
            )
    finally:
        await pool.close()


@app.post("/auth/register", response_model=TokenResponse, status_code=201)
async def register(data: AuthRequest, session: AsyncSession = Depends(get_session)) -> TokenResponse:
    if await session.scalar(select(User).where(User.email == data.email)):
        raise HTTPException(409, "Email is already registered")
    user = User(email=data.email, password_hash=hash_password(data.password))
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return TokenResponse(access_token=create_token(user.id))


@app.post("/auth/login", response_model=TokenResponse)
async def login(data: AuthRequest, session: AsyncSession = Depends(get_session)) -> TokenResponse:
    user = await session.scalar(select(User).where(User.email == data.email))
    if user is None or not verify_password(data.password, user.password_hash):
        raise HTTPException(401, "Invalid credentials")
    return TokenResponse(access_token=create_token(user.id))


@app.put("/users/me/timezone", response_model=TimezoneValue)
async def set_user_timezone(
    data: TimezoneValue,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> TimezoneValue:
    user.timezone = data.timezone
    await session.commit()
    return data


@app.post("/tasks", response_model=TaskResponse, status_code=201)
async def create_task(data: TaskCreate, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)) -> Task:
    return await TaskService.create(session, user, data.model_dump())


@app.get("/tasks", response_model=Page[TaskResponse])
async def list_tasks(limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0), user: User = Depends(current_user), session: AsyncSession = Depends(get_session)) -> Page[TaskResponse]:
    items, total = await TaskService.page(session, user, limit=limit, offset=offset)
    return Page(items=items, total=total, limit=limit, offset=offset)


@app.get("/tasks/{task_id}", response_model=TaskResponse)
async def get_task(task_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)) -> Task:
    task = await TaskService.get(session, user, task_id)
    if task is None:
        raise HTTPException(404, "Task not found")
    return task


@app.patch("/tasks/{task_id}", response_model=TaskResponse)
async def update_task(task_id: uuid.UUID, data: TaskUpdate, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)) -> Task:
    task = await TaskService.update(session, user, task_id, data.model_dump(exclude_unset=True))
    if task is None: raise HTTPException(404, "Task not found")
    return task


@app.delete("/tasks/{task_id}", status_code=204)
async def delete_task(task_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)) -> None:
    if not await TaskService.delete(session, user, task_id): raise HTTPException(404, "Task not found")


@app.post("/events", response_model=EventResponse, status_code=201)
async def create_event(data: EventCreate, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)) -> Event:
    return await EventService.create(session, user, data.model_dump())


@app.get("/events", response_model=Page[EventResponse])
async def list_events(limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0), user: User = Depends(current_user), session: AsyncSession = Depends(get_session)) -> Page[EventResponse]:
    items, total = await EventService.page(session, user, limit=limit, offset=offset)
    return Page(items=items, total=total, limit=limit, offset=offset)


@app.get("/events/{event_id}", response_model=EventResponse)
async def get_event(event_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)) -> Event:
    event = await EventService.get(session, user, event_id)
    if event is None:
        raise HTTPException(404, "Event not found")
    return event


@app.patch("/events/{event_id}", response_model=EventResponse)
async def update_event(event_id: uuid.UUID, data: EventUpdate, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)) -> Event:
    event = await EventService.update(session, user, event_id, data.model_dump(exclude_unset=True))
    if event is None: raise HTTPException(404, "Event not found")
    return event


@app.delete("/events/{event_id}", status_code=204)
async def delete_event(event_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)) -> None:
    if not await EventService.delete(session, user, event_id): raise HTTPException(404, "Event not found")

async def _owned_plan(plan_id: uuid.UUID, user: User, session: AsyncSession) -> ActionPlan:
    plan = await PlanService.get_owned(session, plan_id, user.id)
    if plan is None:
        raise HTTPException(404, "Plan not found")
    return plan


async def _plan_response(plan: ActionPlan, session: AsyncSession) -> ActionPlanResponse:
    return ActionPlanResponse(
        id=plan.id,
        conversation_id=plan.conversation_id,
        source_message_id=plan.source_message_id,
        status=plan.status,
        created_at=plan.created_at,
        expires_at=plan.expires_at,
        actions=await PlanService.actions(session, plan.id),
    )


@app.get("/agent/plans/{plan_id}", response_model=ActionPlanResponse)
async def get_plan(plan_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    return await _plan_response(await _owned_plan(plan_id, user, session), session)


@app.post("/agent/plans/{plan_id}/actions/{action_id}/confirm", status_code=202, response_model=ActionCommandResponse)
async def confirm_action(plan_id: uuid.UUID, action_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    plan = await _owned_plan(plan_id, user, session)
    action, newly_approved = await PlanService.approve_action(session, plan, action_id)
    if action is None:
        raise HTTPException(404, "Action not found")
    if newly_approved or action.status == ActionStatus.approved:
        await enqueue_actions([action.id])
    return ActionCommandResponse(
        plan_id=plan.id, plan_status=plan.status, action_id=action.id,
        action_status=action.status, queued=action.status == ActionStatus.approved,
    )


@app.delete("/agent/plans/{plan_id}/actions/{action_id}", response_model=ActionCommandResponse)
async def remove_action(plan_id: uuid.UUID, action_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    plan = await _owned_plan(plan_id, user, session)
    action = await session.scalar(select(PlannedAction).where(PlannedAction.id == action_id, PlannedAction.plan_id == plan.id))
    if action is None:
        raise HTTPException(404, "Action not found")
    if action.status != ActionStatus.pending:
        raise HTTPException(409, "Action is not pending")
    action.status = ActionStatus.cancelled
    await PlanService.recompute(session, plan)
    await session.commit()
    return ActionCommandResponse(
        plan_id=plan.id, plan_status=plan.status, action_id=action.id,
        action_status=action.status,
    )


@app.post("/agent/plans/{plan_id}/cancel", response_model=ActionCommandResponse)
async def cancel_plan(plan_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    plan = await _owned_plan(plan_id, user, session)
    await PlanService.cancel_pending(session, plan)
    return ActionCommandResponse(plan_id=plan.id, plan_status=plan.status)


@app.post("/agent/plans/{plan_id}/confirm", status_code=202, response_model=ActionCommandResponse)
async def confirm_plan(plan_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    plan = await _owned_plan(plan_id, user, session)
    approved = await PlanService.approve_all(session, plan)
    await enqueue_actions(approved)
    return ActionCommandResponse(
        plan_id=plan.id, plan_status=plan.status, queued=bool(approved),
        queued_action_ids=approved,
    )


async def _new_message(user: User, session: AsyncSession, *, text: str | None, audio_path: str | None, conversation_id: uuid.UUID | None, idempotency_key: str | None) -> AgentMessage:
    if idempotency_key:
        existing = await session.scalar(select(AgentMessage).where(AgentMessage.owner_id == user.id, AgentMessage.idempotency_key == idempotency_key))
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
    last = await session.scalar(select(AgentMessage.sequence).where(AgentMessage.conversation_id == conversation_id).order_by(AgentMessage.sequence.desc()).limit(1))
    message = AgentMessage(owner_id=user.id, conversation_id=conversation_id, sequence=(last or 0) + 1, input_text=text, audio_path=audio_path, idempotency_key=idempotency_key, status=MessageStatus.queued)
    session.add(message)
    await session.commit()
    await session.refresh(message)
    await enqueue(message.id)
    return message


async def _message_response(message: AgentMessage, session: AsyncSession) -> AgentMessageResponse:
    payload = {}
    if message.result:
        try:
            payload = json.loads(message.result)
        except json.JSONDecodeError:
            payload = {"reply": message.result}
    plan = await session.scalar(select(ActionPlan).where(ActionPlan.source_message_id == message.id))
    return AgentMessageResponse(
        id=message.id, conversation_id=message.conversation_id, sequence=message.sequence,
        input_text=message.input_text, status=message.status,
        error=message.error, plan_id=plan.id if plan else None,
        plan_status=plan.status.value if plan else None, reply=payload.get("reply"),
        reads=payload.get("reads", []),
        requires_new_conversation=payload.get("requires_new_conversation", False),
        plan_url=f"/agent/plans/{plan.id}" if plan else None,
        created_at=message.created_at,
    )


@app.post("/agent/messages", response_model=AgentMessageResponse, status_code=202)
async def submit_text_message(data: AgentInput, user: User = Depends(current_user), session: AsyncSession = Depends(get_session), idempotency_key: str | None = Header(default=None)) -> AgentMessageResponse:
    message = await _new_message(user, session, text=data.text, audio_path=None, conversation_id=data.conversation_id, idempotency_key=idempotency_key)
    return await _message_response(message, session)


@app.post("/agent/messages/audio", response_model=AgentMessageResponse, status_code=202)
async def submit_audio_message(audio: UploadFile = File(...), conversation_id: uuid.UUID | None = None, user: User = Depends(current_user), session: AsyncSession = Depends(get_session), idempotency_key: str | None = Header(default=None)) -> AgentMessageResponse:
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    audio_path = AUDIO_DIR / f"{uuid.uuid4()}-{audio.filename or 'message.audio'}"
    audio_path.write_bytes(await audio.read())
    message = await _new_message(user, session, text=None, audio_path=str(audio_path), conversation_id=conversation_id, idempotency_key=idempotency_key)
    return await _message_response(message, session)


@app.get("/agent/messages/{message_id}", response_model=AgentMessageResponse)
async def get_message(message_id: uuid.UUID, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)) -> AgentMessageResponse:
    message = await session.scalar(select(AgentMessage).where(AgentMessage.id == message_id, AgentMessage.owner_id == user.id))
    if message is None:
        raise HTTPException(404, "Message not found")
    return await _message_response(message, session)


@app.get("/agent/conversations/{conversation_id}/messages", response_model=Page[AgentMessageResponse])
async def conversation_messages(conversation_id: uuid.UUID, limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0), user: User = Depends(current_user), session: AsyncSession = Depends(get_session)) -> Page[AgentMessageResponse]:
    base = (AgentMessage.conversation_id == conversation_id, AgentMessage.owner_id == user.id)
    messages = list((await session.scalars(select(AgentMessage).where(*base).order_by(AgentMessage.sequence).offset(offset).limit(limit))).all())
    total = int(await session.scalar(select(func.count()).select_from(AgentMessage).where(*base)) or 0)
    items = [await _message_response(message, session) for message in messages]
    return Page(items=items, total=total, limit=limit, offset=offset)
