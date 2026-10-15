import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal, TypedDict
from zoneinfo import ZoneInfo

import httpx
from langgraph.graph import END, START, StateGraph
from pydantic import ValidationError
from sqlalchemy import select

from .agent_tools import (
    AgentTool,
    CommitCalendarCommandArgs,
    FinishResponseArgs,
    RequestClarificationArgs,
    SchedulingPolicy,
    default_tool_registry,
)
from .calendar import (
    CalendarCommandService,
    CalendarTargetNotFound,
    CalendarValidationError,
    operation_dict,
)
from .config import get_settings
from .llm import (
    auth_headers,
    completion_payload,
    normalize_base_url,
    react_completion_payload,
)
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
    scheduling_policy: SchedulingPolicy = field(default_factory=SchedulingPolicy)


class AgentState(TypedDict, total=False):
    text: str
    state: str
    result: str
    context: AgentRunContext
    messages: list[dict[str, Any]]
    model_message: dict[str, Any]
    model_turns: int
    tool_call_count: int
    repair_count: int
    pending_calls: list[dict[str, Any]]
    terminal_call: dict[str, Any]
    route: str
    reply: str
    reads: list[dict]
    operations: list[dict]
    known_resources: list[str]


class LLMProtocolError(RuntimeError):
    pass


class ContextWindowExceeded(RuntimeError):
    pass


class TranscriptionError(RuntimeError):
    """A safe, user-facing speech recognition failure."""


def build_system_prompt(local_now: datetime, timezone_name: str) -> str:
    return f"""You are a tool-using agent inside a planner application.
Current local datetime: {local_now.isoformat()}
User IANA timezone: {timezone_name}
Resolve relative dates such as today and tomorrow against this local datetime. Return all deadline and starts_at values as absolute ISO-8601 datetimes with an explicit UTC offset.
Use read tools whenever facts from the calendar are required. Observe their structured results before deciding the next action. Never guess an existing record ID, time, duration, title, or search result.
For time-bounded list requests, use a time_range with timezone-aware `from` (inclusive) and `to` (exclusive). For broad requests such as "what do I have tomorrow", call both list_tasks and list_events with the same local-day range.
Every run must finish with exactly one terminal tool: finish_response, request_clarification, or commit_calendar_command. Never combine a terminal tool with read tools in one response.
Every terminal tool must contain a non-empty reply or question for the user.
Create may be committed directly when all required facts are present. Before update or delete, identify the target from fresh tool observations or the supplied referenced records. commit_calendar_command executes all mutations immediately and atomically; describe them as completed actions, never as a plan awaiting confirmation.
Treat the timezone above as authoritative and never ask the user to confirm it. Infer a useful title from the request: for example, "встреча с Ильёй" is already a sufficient event title. Ask for clarification only when a required fact such as an event date or time is truly absent.
Resolve pronouns and short references such as "она", "эта конференция", or "эта встреча" against the entire conversation and the current referenced records supplied after the history. Those records contain fresh database values and are authoritative.
When the user asks to change only a person, organization, conference, place, or another fragment inside a compound title, return the complete resulting title in payload.title and preserve every unrequested part exactly. For example, changing "Acme" to "Contoso" in "Подготовить отчёт для Acme за квартал" must produce "Подготовить отчёт для Contoso за квартал", not merely "Contoso". Replace the entire title only when the user explicitly requests a complete rename.
If no record matches, finish with a clear not-found answer. If several records could satisfy an update and the intended record is unclear, request clarification and do not mutate.
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


def _response_message(body: dict[str, Any]) -> dict[str, Any]:
    try:
        message = body["choices"][0]["message"]
    except (KeyError, IndexError, TypeError) as exc:
        raise LLMProtocolError("LLM returned an invalid chat completion response") from exc
    if not isinstance(message, dict):
        raise LLMProtocolError("LLM returned an invalid assistant message")
    content = message.get("content")
    tool_calls = message.get("tool_calls")
    if tool_calls is None:
        tool_calls = []
    if not isinstance(tool_calls, list):
        raise LLMProtocolError("LLM returned invalid tool calls")
    if not tool_calls and (not isinstance(content, str) or not content.strip()):
        detail = (
            "; reasoning_content was returned instead" if message.get("reasoning_content") else ""
        )
        raise LLMProtocolError(f"LLM returned neither content nor tool calls{detail}")
    return {"role": "assistant", "content": content, "tool_calls": tool_calls}


async def _complete_react(
    messages: list[dict[str, Any]], tools: list[dict[str, Any]]
) -> dict[str, Any]:
    settings = get_settings()
    if not settings.llm_base_url:
        raise RuntimeError("LLM is not configured")
    payload = react_completion_payload(settings, messages, tools)
    async with httpx.AsyncClient(timeout=settings.llm_request_timeout_seconds) as client:
        response = await client.post(
            f"{normalize_base_url(settings.llm_base_url)}/chat/completions",
            headers=auth_headers(settings),
            json=payload,
        )
        if _context_window_exceeded(response):
            raise ContextWindowExceeded("LLM context window exceeded")
        response.raise_for_status()
    return _response_message(response.json())


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


def get_tool_registry() -> dict[str, AgentTool]:
    return dict(default_tool_registry())


def _tool_schemas() -> list[dict[str, Any]]:
    return [tool.openai_schema() for tool in get_tool_registry().values()]


def _resource_key(resource: object, ident: object) -> str | None:
    reference = _resource_reference(resource, ident)
    return f"{reference[0]}:{reference[1]}" if reference else None


async def _prepare_context(state: AgentState) -> AgentState:
    timezone_name = "UTC"
    observed_at_utc = datetime.now(UTC)
    history: list[dict[str, str]] = []
    resource_context: list[dict] = []
    context = state.get("context")
    if context is not None:
        user = await context.session.get(User, context.owner_id)
        if user is None:
            return {"state": "failed", "result": INVALID_DECISION_RESULT}
        timezone_name = user.timezone
        observed_at_utc = context.observed_at_utc
        messages = await _conversation_messages(context)
        history = _history_from_messages(messages)
        resource_context = await _referenced_resource_context(context, messages)
    local_now = observed_at_utc.astimezone(ZoneInfo(timezone_name))
    llm_messages: list[dict[str, Any]] = [
        {"role": "system", "content": build_system_prompt(local_now, timezone_name)},
        *history,
    ]
    if resource_context:
        llm_messages.append(
            {
                "role": "system",
                "content": (
                    "Current referenced records, freshly loaded from the database. "
                    "Use their complete fields and IDs when resolving the current request:\n"
                    + json.dumps({"referenced_resources": resource_context}, ensure_ascii=False)
                ),
            }
        )
    llm_messages.append({"role": "user", "content": state["text"]})
    known_resources = [
        key
        for item in resource_context
        if (key := _resource_key(item.get("resource"), item.get("id"))) is not None
    ]
    return {
        "messages": llm_messages,
        "reads": [],
        "operations": [],
        "known_resources": known_resources,
        "model_turns": 0,
        "tool_call_count": 0,
        "repair_count": 0,
    }


def _route_after_prepare(state: AgentState) -> Literal["call_model", "failed"]:
    return "failed" if state.get("state") == "failed" else "call_model"


def _limit_result() -> str:
    return json.dumps(
        {
            "reply": (
                "Не удалось завершить запрос за допустимое число шагов. "
                "Переформулируйте или уточните запрос и попробуйте ещё раз."
            )
        },
        ensure_ascii=False,
    )


async def _call_model(state: AgentState) -> AgentState:
    settings = get_settings()
    turns = state.get("model_turns", 0)
    if turns >= settings.agent_max_model_turns:
        return {"state": "failed", "result": _limit_result(), "route": "failed"}
    try:
        message = await _complete_react(state["messages"], _tool_schemas())
        logger.info(
            "Agent model turn completed turn=%s message_id=%s",
            turns + 1,
            state.get("context").source_message_id if state.get("context") else None,
        )
        return {
            "model_message": message,
            "messages": [*state["messages"], message],
            "model_turns": turns + 1,
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
            "route": "failed",
        }
    except LLMProtocolError as exc:
        logger.warning("LLM protocol validation failed: %s", exc)
        return {"state": "failed", "result": INVALID_DECISION_RESULT, "route": "failed"}
    except httpx.HTTPError as exc:
        logger.warning("LLM request failed: %s", type(exc).__name__)
        return {
            "state": "failed",
            "result": json.dumps(
                {"reply": "Не удалось связаться с моделью. Попробуйте ещё раз."},
                ensure_ascii=False,
            ),
            "route": "failed",
        }
    except RuntimeError as exc:
        return {"state": "needs_clarification", "result": str(exc), "route": "failed"}


def _route_after_model(state: AgentState) -> Literal["process_model", "clarify", "failed"]:
    if state.get("state") == "needs_clarification":
        return "clarify"
    return "failed" if state.get("state") else "process_model"


def _safe_tool_error(code: str, message: str) -> str:
    return json.dumps(
        {"ok": False, "error": {"code": code, "message": message}}, ensure_ascii=False
    )


def _tool_result_message(call_id: str, name: str, content: str) -> dict[str, Any]:
    return {"role": "tool", "tool_call_id": call_id, "name": name, "content": content}


def _raw_tool_call(value: object) -> tuple[str, str, object]:
    if not isinstance(value, dict):
        raise TypeError("tool call must be an object")
    call_id = value.get("id")
    function = value.get("function")
    if not isinstance(call_id, str) or not call_id or not isinstance(function, dict):
        raise ValueError("tool call id and function are required")
    name = function.get("name")
    arguments = function.get("arguments")
    if not isinstance(name, str) or not name:
        raise ValueError("tool name is required")
    return call_id, name, arguments


def _arguments_object(value: object) -> dict[str, Any]:
    if isinstance(value, str):
        parsed = json.loads(value)
    else:
        parsed = value
    if not isinstance(parsed, dict):
        raise TypeError("tool arguments must be an object")
    return parsed


async def _process_model(state: AgentState) -> AgentState:
    registry = get_tool_registry()
    raw_calls = state["model_message"].get("tool_calls", [])
    settings = get_settings()
    call_count = state.get("tool_call_count", 0) + len(raw_calls)
    if call_count > settings.agent_max_tool_calls:
        return {
            "state": "failed",
            "result": _limit_result(),
            "route": "failed",
            "tool_call_count": call_count,
        }
    if not raw_calls:
        messages = [
            *state["messages"],
            {
                "role": "system",
                "content": json.dumps(
                    {
                        "protocol_error": (
                            "A terminal tool call is required; plain assistant content cannot finish."
                        )
                    }
                ),
            },
        ]
        return {
            "messages": messages,
            "repair_count": state.get("repair_count", 0) + 1,
            "tool_call_count": call_count,
            "route": "retry",
        }

    validated: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for raw_call in raw_calls:
        call_id = "invalid"
        name = "unknown"
        try:
            call_id, name, arguments = _raw_tool_call(raw_call)
            tool = registry.get(name)
            if tool is None:
                raise LookupError("unknown_tool")
            args = tool.args_model.model_validate(_arguments_object(arguments))
            validated.append({"id": call_id, "name": name, "tool": tool, "args": args})
        except LookupError:
            errors.append(
                _tool_result_message(
                    call_id, name, _safe_tool_error("unknown_tool", "Инструмент недоступен")
                )
            )
        except (ValueError, TypeError, json.JSONDecodeError, ValidationError):
            errors.append(
                _tool_result_message(
                    call_id,
                    name,
                    _safe_tool_error("invalid_arguments", "Некорректные аргументы инструмента"),
                )
            )
    kinds = {item["tool"].kind for item in validated}
    terminal_count = sum(item["tool"].kind == "terminal" for item in validated)
    if not errors and (len(kinds) > 1 or terminal_count > 1):
        for item in validated:
            errors.append(
                _tool_result_message(
                    item["id"],
                    item["name"],
                    _safe_tool_error(
                        "mixed_tool_calls",
                        "Terminal и read tools нужно вызывать на разных шагах",
                    ),
                )
            )
    if errors:
        rejected_ids = {item["tool_call_id"] for item in errors}
        for item in validated:
            if item["id"] not in rejected_ids:
                errors.append(
                    _tool_result_message(
                        item["id"],
                        item["name"],
                        _safe_tool_error(
                            "tool_batch_rejected",
                            "Пакет инструментов отклонён из-за ошибки другого вызова",
                        ),
                    )
                )
        return {
            "messages": [*state["messages"], *errors],
            "repair_count": state.get("repair_count", 0) + 1,
            "tool_call_count": call_count,
            "route": "retry",
        }
    if terminal_count == 1:
        return {
            "terminal_call": validated[0],
            "tool_call_count": call_count,
            "route": "terminal",
        }
    return {"pending_calls": validated, "tool_call_count": call_count, "route": "reads"}


def _route_after_processing(
    state: AgentState,
) -> Literal["execute_reads", "validate_terminal", "call_model", "failed"]:
    return {
        "reads": "execute_reads",
        "terminal": "validate_terminal",
        "retry": "call_model",
        "failed": "failed",
    }[state["route"]]


async def _execute_read_tools(state: AgentState) -> AgentState:
    context = state.get("context")
    messages = list(state["messages"])
    reads = list(state.get("reads", []))
    known = list(state.get("known_resources", []))
    observation_limit = get_settings().agent_max_observation_items
    for call in state["pending_calls"]:
        tool: AgentTool = call["tool"]
        started_at = time.perf_counter()
        try:
            if context is None or tool.executor is None:
                raise RuntimeError("tool runtime context is unavailable")
            data = await tool.executor(context, call["args"], observation_limit)
            for item in data:
                key = _resource_key(item.get("resource"), item.get("id"))
                if key:
                    reads.append(item)
                    if key not in known:
                        known.append(key)
            content = json.dumps({"ok": True, "tool": tool.name, "data": data}, ensure_ascii=False)
        except Exception as exc:  # noqa: BLE001 - tools are an isolation boundary
            logger.warning("Agent read tool %s failed: %s", tool.name, type(exc).__name__)
            content = _safe_tool_error("tool_failed", "Не удалось выполнить чтение календаря")
        logger.info(
            "Agent read tool completed tool=%s duration_ms=%.1f message_id=%s",
            tool.name,
            (time.perf_counter() - started_at) * 1000,
            context.source_message_id if context else None,
        )
        messages.append(_tool_result_message(call["id"], call["name"], content))
    return {"messages": messages, "reads": reads, "known_resources": known}


async def _validate_terminal(state: AgentState) -> AgentState:
    call = state["terminal_call"]
    name = call["name"]
    args = call["args"]
    if name == "finish_response":
        parsed = FinishResponseArgs.model_validate(args)
        return {"reply": parsed.reply, "route": "finish"}
    if name == "request_clarification":
        parsed = RequestClarificationArgs.model_validate(args)
        return {"reply": parsed.question, "route": "clarify"}
    if name != "commit_calendar_command":
        return {"state": "failed", "result": INVALID_DECISION_RESULT, "route": "failed"}

    parsed = CommitCalendarCommandArgs.model_validate(args)
    known = set(state.get("known_resources", []))
    context = state.get("context")
    user = await context.session.get(User, context.owner_id) if context else None
    missing: list[str] = []
    for mutation in parsed.mutations:
        if mutation.operation not in {"update", "delete"}:
            continue
        key = _resource_key(mutation.resource, mutation.target_id)
        service = TaskService if mutation.resource == "task" else EventService
        current = (
            await service.get(context.session, user, mutation.target_id)
            if context is not None and user is not None
            else None
        )
        if key not in known or current is None:
            missing.append(key or "unknown")
    if missing:
        error = _tool_result_message(
            call["id"],
            name,
            _safe_tool_error(
                "target_not_observed",
                "Перед update/delete нужно найти актуальную owner-scoped запись read tool",
            ),
        )
        return {
            "messages": [*state["messages"], error],
            "repair_count": state.get("repair_count", 0) + 1,
            "route": "retry",
        }
    return {
        "reply": parsed.reply,
        "terminal_call": {**call, "args": parsed},
        "route": "commit",
    }


def _route_after_terminal(
    state: AgentState,
) -> Literal["commit_mutations", "finish", "clarify", "call_model", "failed"]:
    return {
        "commit": "commit_mutations",
        "finish": "finish",
        "clarify": "clarify",
        "retry": "call_model",
        "failed": "failed",
    }[state["route"]]


async def _commit_mutations(state: AgentState) -> AgentState:
    context = state.get("context")
    if context is None:
        return {"state": "failed", "result": INVALID_DECISION_RESULT}
    user = await context.session.get(User, context.owner_id)
    if user is None:
        return {"state": "failed", "result": INVALID_DECISION_RESULT}
    args = CommitCalendarCommandArgs.model_validate(state["terminal_call"]["args"])
    try:
        operations = await CalendarCommandService.execute(
            context.session,
            user,
            args.mutations,
            origin="agent",
            command_id=context.source_message_id,
            source_message_id=context.source_message_id,
        )
    except (CalendarTargetNotFound, CalendarValidationError) as exc:
        logger.warning("Calendar command rejected: %s", type(exc).__name__)
        return {"state": "failed", "result": INVALID_DECISION_RESULT}
    except Exception as exc:
        logger.exception("Calendar command failed: %s", type(exc).__name__)
        return {
            "state": "failed",
            "result": json.dumps(
                {"reply": "Не удалось изменить календарь. Попробуйте ещё раз."},
                ensure_ascii=False,
            ),
        }
    return {"operations": [operation_dict(item) for item in operations]}


def _route_after_commit(state: AgentState) -> Literal["finish", "failed"]:
    return "failed" if state.get("state") == "failed" else "finish"


async def _failed(state: AgentState) -> AgentState:
    return {"state": "failed", "result": state.get("result", "Agent processing failed")}


async def _clarify(state: AgentState) -> AgentState:
    return {
        "state": "needs_clarification",
        "result": state.get("result")
        or json.dumps({"reply": state.get("reply", "Нужно уточнение")}, ensure_ascii=False),
    }


async def _finish(state: AgentState) -> AgentState:
    result = {"reply": state["reply"], "reads": state.get("reads", [])}
    result["operations"] = state.get("operations", [])
    return {
        "state": "completed",
        "result": json.dumps(result, ensure_ascii=False),
    }


@lru_cache(maxsize=1)
def _compiled_graph():
    graph = StateGraph(AgentState)
    graph.add_node("prepare_context", _prepare_context)
    graph.add_node("call_model", _call_model)
    graph.add_node("process_model", _process_model)
    graph.add_node("execute_reads", _execute_read_tools)
    graph.add_node("validate_terminal", _validate_terminal)
    graph.add_node("commit_mutations", _commit_mutations)
    graph.add_node("clarify", _clarify)
    graph.add_node("failed", _failed)
    graph.add_node("finish", _finish)
    graph.add_edge(START, "prepare_context")
    graph.add_conditional_edges("prepare_context", _route_after_prepare)
    graph.add_conditional_edges("call_model", _route_after_model)
    graph.add_conditional_edges("process_model", _route_after_processing)
    graph.add_edge("execute_reads", "call_model")
    graph.add_conditional_edges("validate_terminal", _route_after_terminal)
    graph.add_conditional_edges("commit_mutations", _route_after_commit)
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
