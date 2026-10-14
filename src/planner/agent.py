import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from typing import Literal, TypedDict
from zoneinfo import ZoneInfo

import httpx
from langgraph.graph import END, START, StateGraph
from sqlalchemy import select

from .config import get_settings
from .llm import auth_headers, completion_payload, normalize_base_url
from .models import AgentMessage, User
from .plans import PlanService
from .schemas import DecisionEnvelope
from .services import EventService, TaskService


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
    observed_at_utc: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


class AgentState(TypedDict, total=False):
    text: str
    llm_output: str
    state: str
    result: str
    decision: dict
    context: AgentRunContext
    reads: list[dict]
    plan_id: str


class LLMProtocolError(RuntimeError):
    pass


class ContextWindowExceeded(RuntimeError):
    pass


def build_system_prompt(local_now: datetime, timezone_name: str) -> str:
    return f"""You are the command interpreter inside a planner application. Return JSON only and follow the supplied JSON schema exactly.
Current local datetime: {local_now.isoformat()}
User IANA timezone: {timezone_name}
Resolve relative dates such as today and tomorrow against this local datetime. Return all deadline and starts_at values as absolute ISO-8601 datetimes with an explicit UTC offset.
The application has access to the user's tasks and events. For requests to show, list, find, or get them, populate reads; the application will execute those reads immediately.
For create, update, and delete requests, populate mutations; the application will show them as a confirmation plan. Never say that a mutation has already been executed. Say that a plan was prepared.
Treat the timezone above as authoritative and never ask the user to confirm it. Infer a useful title from the request: for example, "встреча с Ильёй" is already a sufficient event title. Ask for clarification only when a required fact such as an event date or time is truly absent.
Use only payload fields declared by the schema. For event time use starts_at, never start. For a new task omit status unless the user explicitly requested one."""


def _response_content(body: dict) -> str:
    try:
        message = body["choices"][0]["message"]
        content = message["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise LLMProtocolError("LLM returned an invalid chat completion response") from exc
    if not isinstance(content, str) or not content.strip():
        detail = "; reasoning_content was returned instead" if message.get("reasoning_content") else ""
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
) -> str:
    settings = get_settings()
    if not settings.llm_base_url:
        raise RuntimeError("LLM is not configured")
    messages = [
        {"role": "system", "content": system_prompt},
        *(history or []),
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


async def _conversation_history(context: AgentRunContext) -> list[dict[str, str]]:
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
    messages = list((await context.session.scalars(query)).all())
    history: list[dict[str, str]] = []
    for message in messages:
        if message.input_text:
            history.append({"role": "user", "content": message.input_text})
        assistant_content = _assistant_history_content(message.result)
        if assistant_content:
            history.append({"role": "assistant", "content": assistant_content})
    return history


async def _interpret(state: AgentState) -> AgentState:
    timezone_name = "UTC"
    observed_at_utc = datetime.now(timezone.utc)
    history: list[dict[str, str]] = []
    context = state.get("context")
    if context is not None:
        user = await context.session.get(User, context.owner_id)
        if user is None:
            return {"state": "failed", "result": "Agent owner not found"}
        timezone_name = user.timezone
        observed_at_utc = context.observed_at_utc
        history = await _conversation_history(context)
    local_now = observed_at_utc.astimezone(ZoneInfo(timezone_name))
    try:
        return {
            "llm_output": await _complete(
                state["text"],
                system_prompt=build_system_prompt(local_now, timezone_name),
                history=history,
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
        return {"state": "failed", "result": str(exc)}
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
        return {"state": "failed", "result": str(exc)}
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
        rows = ([await service.get(context.session, user, read.target_id)]
                if read.operation == "get" else await service.list(context.session, user))
        for row in filter(None, rows):
            data = {
                column.name: getattr(row, column.name)
                for column in row.__table__.columns
                if column.name != "owner_id"
            }
            results.append(json.loads(json.dumps(
                {"resource": read.resource, "id": str(row.id), "data": data}, default=str
            )))
    return {"reads": results}


async def _build_plan(state: AgentState) -> AgentState:
    return {"decision": state["decision"]}


async def _persist_plan(state: AgentState) -> AgentState:
    decision = DecisionEnvelope.model_validate(state["decision"])
    if not decision.mutations:
        return {}
    context = state.get("context")
    if context is None:
        raise RuntimeError("Agent runtime context is required for mutations")
    plan = await PlanService.create(
        context.session,
        owner_id=context.owner_id,
        conversation_id=context.conversation_id,
        source_message_id=context.source_message_id,
        mutations=decision.mutations,
    )
    return {"plan_id": str(plan.id)}


async def _failed(state: AgentState) -> AgentState:
    return {"state": "failed", "result": state.get("result", "Agent processing failed")}


async def _clarify(state: AgentState) -> AgentState:
    return {"state": "needs_clarification", "result": state.get("result", "The request needs clarification")}


async def _finish(state: AgentState) -> AgentState:
    decision = DecisionEnvelope.model_validate(state["decision"])
    result = {"reply": decision.reply, "reads": state.get("reads", [])}
    if state.get("plan_id"):
        result["plan_id"] = state["plan_id"]
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
    graph.add_node("build_plan", _build_plan)
    graph.add_node("persist_plan", _persist_plan)
    graph.add_node("clarify", _clarify)
    graph.add_node("failed", _failed)
    graph.add_node("finish", _finish)
    graph.add_edge(START, "interpret")
    graph.add_conditional_edges("interpret", _route_after_interpret)
    graph.add_conditional_edges("validate_decision", _route_after_validation)
    graph.add_edge("execute_reads", "build_plan")
    graph.add_edge("build_plan", "persist_plan")
    graph.add_edge("persist_plan", "finish")
    graph.add_edge("clarify", END)
    graph.add_edge("failed", END)
    graph.add_edge("finish", END)
    return graph.compile()


async def transcribe(audio_path: str) -> str:
    settings = get_settings()
    if not settings.stt_base_url:
        raise RuntimeError("STT_BASE_URL is not configured")
    async with httpx.AsyncClient(timeout=120) as client:
        with open(audio_path, "rb") as audio:
            response = await client.post(
                f"{settings.stt_base_url.rstrip('/')}/audio/transcriptions",
                headers={"Authorization": f"Bearer {settings.stt_api_key}"},
                files={"file": audio},
                data={"model": settings.stt_model},
            )
        response.raise_for_status()
        return response.json()["text"]


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
