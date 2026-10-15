import asyncio
import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Literal, TypedDict
from zoneinfo import ZoneInfo

import httpx
from langgraph.graph import END, START, StateGraph
from sqlalchemy import select

from .calendar import CalendarCommandService, operation_dict
from .config import get_settings
from .llm import auth_headers, completion_payload, normalize_base_url
from .models import AgentMessage, CalendarOperation, User
from .schemas import DecisionEnvelope
from .services import EventService, TaskService

logger = logging.getLogger(__name__)
INVALID_DECISION_RESULT = json.dumps(
    {
        "reply": (
            "Не удалось корректно разобрать запрос. Переформулируйте его и попробуйте ещё раз."
        )
    },
    ensure_ascii=False,
)


@dataclass
class AgentResult:
    state: str
    result: str


@dataclass
class AgentRunContext:
    session: object
    owner_id: uuid.UUID
    conversation_id: uuid.UUID
    source_message_id: uuid.UUID
    observed_at_utc: datetime = field(default_factory=lambda: datetime.now(UTC))


class AgentState(TypedDict, total=False):
    text: str
    llm_output: str
    state: str
    result: str
    decision: dict
    context: AgentRunContext
    reads: list[dict]
    operations: list[dict]


class LLMProtocolError(RuntimeError):
    pass


class ContextWindowExceeded(RuntimeError):
    pass


class TranscriptionError(RuntimeError):
    """A safe, user-facing speech recognition failure."""


def build_system_prompt(local_now: datetime, timezone_name: str) -> str:
    return f"""You are the command interpreter inside a planner application. Return JSON only and follow the supplied JSON schema exactly.
Current local datetime: {local_now.isoformat()}
User IANA timezone: {timezone_name}
Resolve relative dates such as today and tomorrow against this local datetime. Return all deadline and starts_at values as absolute ISO-8601 datetimes with an explicit UTC offset.
The application has access to the user's tasks and events. For requests to show, list, find, or get them, populate reads; the application will execute those reads immediately.
For time-bounded list requests, include a time_range with timezone-aware `from` (inclusive) and `to` (exclusive). Apply it to event starts_at or task deadline. For broad requests such as "what do I have tomorrow", request both tasks and events with the same local-day range.
For create, update, and delete requests, populate mutations; the application executes all mutations immediately and atomically. Describe them as completed actions, never as a plan awaiting confirmation.
Treat the timezone above as authoritative and never ask the user to confirm it. Infer a useful title from the request: for example, "встреча с Ильёй" is already a sufficient event title. Ask for clarification only when a required fact such as an event date or time is truly absent.
Always return a non-empty reply. When clarification is needed, put the question in both reply and clarification, and leave reads and mutations empty.
Resolve pronouns and short references such as "она", "эта конференция", or "эта встреча" against the entire conversation and the current referenced records supplied after the history. Those records contain fresh database values and are authoritative.
When the user asks to change only a person, organization, conference, place, or another fragment inside a compound title, return the complete resulting title in payload.title and preserve every unrequested part exactly. For example, changing "Acme" to "Contoso" in "Подготовить отчёт для Acme за квартал" must produce "Подготовить отчёт для Contoso за квартал", not merely "Contoso". Replace the entire title only when the user explicitly requests a complete rename.
If more than one referenced record could satisfy an update or the intended record is unclear, return a clarification and no mutation.
Use only payload fields declared by the schema. For event time use starts_at, never start. For a new task omit status unless the user explicitly requested one."""


def _response_content(body: dict) -> str:
    try:
        message = body["choices"][0]["message"]
        content = message["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise LLMProtocolError("LLM returned an invalid chat completion response") from exc
    if not isinstance(content, str) or not content.strip():
        detail = (
            "; reasoning_content was returned instead" if message.get("reasoning_content") else ""
        )
        raise LLMProtocolError(f"LLM returned empty message content{detail}")
    return content


def _context_window_exceeded(response: httpx.Response) -> bool:
    if response.status_code not in {400, 413, 422}:
        return False
    detail = response.text.lower()
    markers = (
        "context window",
        "context length",
        "context_length",
        "too many tokens",
        "prompt is too long",
        "input is too long",
        "maximum context",
    )
    return any(marker in detail for marker in markers)


async def _complete(
    text: str,
    *,
    system_prompt: str,
    history: list[dict[str, str]] | None = None,
    resource_context: list[dict] | None = None,
) -> str:
    settings = get_settings()
    if not settings.llm_base_url:
        raise RuntimeError("LLM is not configured")
    messages = [
        {"role": "system", "content": system_prompt},
        *(history or []),
        *(
            [
                {
                    "role": "system",
                    "content": (
                        "Current referenced records, freshly loaded from the database. "
                        "Use their complete fields and IDs when resolving the current request:\n"
                        + json.dumps({"referenced_resources": resource_context}, ensure_ascii=False)
                    ),
                }
            ]
            if resource_context
            else []
        ),
        {"role": "user", "content": text},
    ]
    payload = completion_payload(settings, messages)
    async with httpx.AsyncClient(timeout=settings.llm_request_timeout_seconds) as client:
        response = await client.post(
            f"{normalize_base_url(settings.llm_base_url)}/chat/completions",
            headers=auth_headers(settings),
            json=payload,
        )
        if _context_window_exceeded(response):
            raise ContextWindowExceeded("LLM context window exceeded")
        response.raise_for_status()
    return _response_content(response.json())


def _assistant_history_content(result: str | None) -> str | None:
    if not result:
        return None
    try:
        value = json.loads(result)
    except json.JSONDecodeError:
        return result
    return json.dumps(value, ensure_ascii=False)


async def _conversation_messages(context: AgentRunContext) -> list[AgentMessage]:
    current = await context.session.get(AgentMessage, context.source_message_id)
    if current is None:
        raise RuntimeError("Current agent message not found")
    query = (
        select(AgentMessage)
        .where(
            AgentMessage.owner_id == context.owner_id,
            AgentMessage.conversation_id == context.conversation_id,
            AgentMessage.sequence < current.sequence,
        )
        .order_by(AgentMessage.sequence)
    )
    return list((await context.session.scalars(query)).all())


def _history_from_messages(messages: list[AgentMessage]) -> list[dict[str, str]]:
    history: list[dict[str, str]] = []
    for message in messages:
        if message.input_text:
            history.append({"role": "user", "content": message.input_text})
        assistant_content = _assistant_history_content(message.result)
        if assistant_content:
            history.append({"role": "assistant", "content": assistant_content})
    return history


async def _conversation_history(context: AgentRunContext) -> list[dict[str, str]]:
    return _history_from_messages(await _conversation_messages(context))


def _result_payload(result: str | None) -> dict:
    if not result:
        return {}
    try:
        value = json.loads(result)
    except (json.JSONDecodeError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def _resource_reference(resource: object, ident: object) -> tuple[str, uuid.UUID] | None:
    if resource not in {"task", "event"} or not ident:
        return None
    try:
        return str(resource), uuid.UUID(str(ident))
    except (TypeError, ValueError, AttributeError):
        return None


async def _referenced_resource_context(
    context: AgentRunContext,
    messages: list[AgentMessage],
) -> list[dict]:
    references: dict[tuple[str, uuid.UUID], None] = {}
    message_ids: list[uuid.UUID] = []
    for message in messages:
        payload = _result_payload(message.result)
        reads = payload.get("reads", [])
        if isinstance(reads, list):
            for read in reads:
                if not isinstance(read, dict):
                    continue
                reference = _resource_reference(read.get("resource"), read.get("id"))
                if reference:
                    references.pop(reference, None)
                    references[reference] = None
        message_ids.append(message.id)

    if message_ids:
        operations = list(
            (
                await context.session.scalars(
                    select(CalendarOperation)
                    .where(
                        CalendarOperation.source_message_id.in_(message_ids),
                        CalendarOperation.owner_id == context.owner_id,
                    )
                    .order_by(CalendarOperation.sequence)
                )
            ).all()
        )
        for operation in operations:
            reference = _resource_reference(operation.resource, operation.target_id)
            if reference:
                references.pop(reference, None)
                references[reference] = None

    user = await context.session.get(User, context.owner_id)
    if user is None:
        return []
    resources: list[dict] = []
    for resource, ident in references:
        service = TaskService if resource == "task" else EventService
        row = await service.get(context.session, user, ident)
        if row is None:
            continue
        data = {
            column.name: getattr(row, column.name)
            for column in row.__table__.columns
            if column.name != "owner_id"
        }
        resources.append(
            json.loads(
                json.dumps({"resource": resource, "id": str(row.id), "data": data}, default=str)
            )
        )
    return resources


async def _interpret(state: AgentState) -> AgentState:
    timezone_name = "UTC"
    observed_at_utc = datetime.now(UTC)
    history: list[dict[str, str]] = []
    resource_context: list[dict] = []
    context = state.get("context")
    if context is not None:
        user = await context.session.get(User, context.owner_id)
        if user is None:
            return {"state": "failed", "result": "Agent owner not found"}
        timezone_name = user.timezone
        observed_at_utc = context.observed_at_utc
        messages = await _conversation_messages(context)
        history = _history_from_messages(messages)
        resource_context = await _referenced_resource_context(context, messages)
    local_now = observed_at_utc.astimezone(ZoneInfo(timezone_name))
    try:
        return {
            "llm_output": await _complete(
                state["text"],
                system_prompt=build_system_prompt(local_now, timezone_name),
                history=history,
                resource_context=resource_context,
            )
        }
    except ContextWindowExceeded:
        return {
            "state": "needs_clarification",
            "result": json.dumps(
                {
                    "reply": "История этого диалога больше не помещается в контекст модели. Начните новый диалог, чтобы продолжить.",
                    "requires_new_conversation": True,
                },
                ensure_ascii=False,
            ),
        }
    except LLMProtocolError as exc:
        logger.warning("LLM protocol validation failed: %s", exc)
        return {"state": "failed", "result": INVALID_DECISION_RESULT}
    except RuntimeError as exc:
        return {"state": "needs_clarification", "result": str(exc)}


def _route_after_interpret(state: AgentState) -> Literal["validate_decision", "clarify", "failed"]:
    if state.get("state") == "needs_clarification":
        return "clarify"
    if state.get("state") == "failed":
        return "failed"
    return "validate_decision"


async def _validate_decision(state: AgentState) -> AgentState:
    try:
        decision = parse_decision(state.get("llm_output", ""))
    except (ValueError, TypeError) as exc:
        logger.warning("LLM decision validation failed: %s", exc)
        return {"state": "failed", "result": INVALID_DECISION_RESULT}
    if decision.clarification:
        return {"state": "needs_clarification", "result": decision.clarification}
    return {"decision": decision.model_dump(mode="json")}


def _route_after_validation(state: AgentState) -> Literal["execute_reads", "clarify", "failed"]:
    if state.get("state") == "needs_clarification":
        return "clarify"
    if state.get("state") == "failed":
        return "failed"
    return "execute_reads"


async def _execute_reads(state: AgentState) -> AgentState:
    decision = DecisionEnvelope.model_validate(state["decision"])
    if not decision.reads:
        return {"reads": []}
    context = state.get("context")
    if context is None:
        raise RuntimeError("Agent runtime context is required for reads")
    user = await context.session.get(User, context.owner_id)
    results = []
    for read in decision.reads:
        service = TaskService if read.resource == "task" else EventService
        time_range = getattr(read, "time_range", None)
        rows = (
            [await service.get(context.session, user, read.target_id)]
            if read.operation == "get"
            else await service.list(
                context.session,
                user,
                from_datetime=time_range.from_datetime if time_range else None,
                to_datetime=time_range.to_datetime if time_range else None,
            )
        )
        for row in filter(None, rows):
            data = {
                column.name: getattr(row, column.name)
                for column in row.__table__.columns
                if column.name != "owner_id"
            }
            results.append(
                json.loads(
                    json.dumps(
                        {"resource": read.resource, "id": str(row.id), "data": data}, default=str
                    )
                )
            )
    return {"reads": results}


async def _execute_mutations(state: AgentState) -> AgentState:
    decision = DecisionEnvelope.model_validate(state["decision"])
    if not decision.mutations:
        return {}
    context = state.get("context")
    if context is None:
        raise RuntimeError("Agent runtime context is required for mutations")
    user = await context.session.get(User, context.owner_id)
    if user is None:
        raise RuntimeError("Agent owner not found")
    operations = await CalendarCommandService.execute(
        context.session,
        user,
        decision.mutations,
        origin="agent",
        command_id=context.source_message_id,
        source_message_id=context.source_message_id,
    )
    return {"operations": [operation_dict(item) for item in operations]}


async def _failed(state: AgentState) -> AgentState:
    return {"state": "failed", "result": state.get("result", "Agent processing failed")}


async def _clarify(state: AgentState) -> AgentState:
    return {
        "state": "needs_clarification",
        "result": state.get("result", "The request needs clarification"),
    }


async def _finish(state: AgentState) -> AgentState:
    decision = DecisionEnvelope.model_validate(state["decision"])
    result = {"reply": decision.reply, "reads": state.get("reads", [])}
    result["operations"] = state.get("operations", [])
    return {
        "state": "completed",
        "result": json.dumps(result, ensure_ascii=False),
    }


@lru_cache(maxsize=1)
def _compiled_graph():
    graph = StateGraph(AgentState)
    graph.add_node("interpret", _interpret)
    graph.add_node("validate_decision", _validate_decision)
    graph.add_node("execute_reads", _execute_reads)
    graph.add_node("execute_mutations", _execute_mutations)
    graph.add_node("clarify", _clarify)
    graph.add_node("failed", _failed)
    graph.add_node("finish", _finish)
    graph.add_edge(START, "interpret")
    graph.add_conditional_edges("interpret", _route_after_interpret)
    graph.add_conditional_edges("validate_decision", _route_after_validation)
    graph.add_edge("execute_reads", "execute_mutations")
    graph.add_edge("execute_mutations", "finish")
    graph.add_edge("clarify", END)
    graph.add_edge("failed", END)
    graph.add_edge("finish", END)
    return graph.compile()


async def transcribe(audio_path: str) -> str:
    settings = get_settings()
    if not settings.stt_base_url:
        raise RuntimeError("STT_BASE_URL is not configured")
    headers = {}
    if settings.stt_api_key:
        headers["Authorization"] = f"Bearer {settings.stt_api_key}"
    try:
        audio_path_value = Path(audio_path)
        audio_bytes = await asyncio.to_thread(audio_path_value.read_bytes)
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(
                f"{settings.stt_base_url.rstrip('/')}/audio/transcriptions",
                headers=headers,
                files={"file": (audio_path_value.name, audio_bytes)},
                data={"model": settings.stt_model},
            )
            response.raise_for_status()
    except httpx.RequestError as exc:
        raise TranscriptionError(
            "Не удалось связаться с сервисом распознавания речи. "
            "Проверьте, что GigaAM запущен, и попробуйте записать сообщение ещё раз."
        ) from exc
    except httpx.HTTPStatusError as exc:
        raise TranscriptionError(
            "Сервис распознавания речи не смог обработать запись. "
            "Попробуйте записать сообщение ещё раз."
        ) from exc

    try:
        text = response.json()["text"]
    except (KeyError, TypeError, ValueError) as exc:
        raise TranscriptionError(
            "Сервис распознавания речи вернул некорректный ответ. Попробуйте ещё раз."
        ) from exc
    if not isinstance(text, str) or not text.strip():
        raise TranscriptionError(
            "Сервис распознавания речи вернул некорректный ответ. Попробуйте ещё раз."
        )
    return text.strip()


async def run_agent(text: str, context: AgentRunContext | None = None) -> AgentResult:
    initial: AgentState = {"text": text}
    if context is not None:
        initial["context"] = context
    final_state = await _compiled_graph().ainvoke(initial)
    return AgentResult(final_state["state"], final_state["result"])


def parse_decision(raw: str) -> DecisionEnvelope:
    """Strictly validate the LLM envelope; arbitrary prose can never mutate data."""
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("LLM returned invalid JSON envelope") from exc
    return DecisionEnvelope.model_validate(value)
