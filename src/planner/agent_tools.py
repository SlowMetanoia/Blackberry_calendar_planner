import json
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from pydantic import Field

from .config import get_settings
from .models import User
from .occurrences import OccurrenceService, occurrence_dict
from .schemas import DecisionAction, DecisionTimeRange, StrictInput
from .search import CalendarRetriever
from .services import EventService, TaskService


class ToolRuntimeContext(Protocol):
    session: Any
    owner_id: uuid.UUID


class ListResourcesArgs(StrictInput):
    time_range: DecisionTimeRange | None = None
    limit: int = Field(default=100, ge=1, le=100)


class GetResourceArgs(StrictInput):
    target_id: uuid.UUID


class SearchCalendarArgs(StrictInput):
    query: str = Field(min_length=1, max_length=1000)
    resource: Literal["all", "task", "event"] = "all"
    time_range: DecisionTimeRange | None = None
    cursor: str | None = Field(default=None, max_length=4096)


class CalendarItemReference(StrictInput):
    resource: Literal["task", "event"]
    target_id: uuid.UUID


class ShowCalendarItemsArgs(StrictInput):
    items: list[CalendarItemReference] = Field(min_length=1, max_length=100)


class FinishResponseArgs(StrictInput):
    reply: str = Field(min_length=1, max_length=10_000)


class RequestClarificationArgs(StrictInput):
    question: str = Field(min_length=1, max_length=10_000)


class CommitCalendarCommandArgs(StrictInput):
    reply: str = Field(min_length=1, max_length=10_000)
    mutations: list[DecisionAction] = Field(min_length=1, max_length=50)


ToolKind = Literal["read", "presentation", "terminal"]


@dataclass(frozen=True)
class ToolExecutionResult:
    items: list[dict[str, Any]]
    metadata: dict[str, Any]


ToolExecutor = Callable[
    [ToolRuntimeContext, StrictInput, int],
    Awaitable[list[dict[str, Any]] | ToolExecutionResult],
]


@dataclass(frozen=True)
class AgentTool:
    name: str
    description: str
    args_model: type[StrictInput]
    kind: ToolKind
    executor: ToolExecutor | None = None

    def openai_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.args_model.model_json_schema(),
            },
        }


def _resource_dict(resource: str, row: Any) -> dict[str, Any]:
    data = {
        column.name: getattr(row, column.name)
        for column in row.__table__.columns
        if column.name not in {"owner_id", "recurrence_version_id"}
        and not (
            column.name in {"recurrence", "recurrence_timezone"}
            and getattr(row, column.name) is None
        )
    }
    return json.loads(
        json.dumps({"resource": resource, "id": str(row.id), "data": data}, default=str)
    )


def _list_executor(resource: Literal["task", "event"]) -> ToolExecutor:
    async def execute(
        context: ToolRuntimeContext, raw_args: StrictInput, observation_limit: int
    ) -> list[dict[str, Any]]:
        args = ListResourcesArgs.model_validate(raw_args)
        user = await context.session.get(User, context.owner_id)
        if user is None:
            raise LookupError("agent owner not found")
        service = TaskService if resource == "task" else EventService
        time_range = args.time_range
        if time_range is not None:
            page = await OccurrenceService.page(
                context.session,
                user,
                resource=resource,
                from_datetime=time_range.from_datetime,
                to_datetime=time_range.to_datetime,
                limit=min(args.limit, observation_limit),
            )
            return [
                {
                    "resource": resource,
                    "id": str(item.series_id),
                    "data": occurrence_dict(item),
                }
                for item in page.items
            ]
        rows, _total = await service.page(
            context.session,
            user,
            limit=min(args.limit, observation_limit),
            offset=0,
            from_datetime=time_range.from_datetime if time_range else None,
            to_datetime=time_range.to_datetime if time_range else None,
        )
        return [_resource_dict(resource, row) for row in rows]

    return execute


def _get_executor(resource: Literal["task", "event"]) -> ToolExecutor:
    async def execute(
        context: ToolRuntimeContext, raw_args: StrictInput, _observation_limit: int
    ) -> list[dict[str, Any]]:
        args = GetResourceArgs.model_validate(raw_args)
        user = await context.session.get(User, context.owner_id)
        if user is None:
            raise LookupError("agent owner not found")
        service = TaskService if resource == "task" else EventService
        row = await service.get(context.session, user, args.target_id)
        return [] if row is None else [_resource_dict(resource, row)]

    return execute


async def _search_executor(
    context: ToolRuntimeContext, raw_args: StrictInput, observation_limit: int
) -> ToolExecutionResult:
    args = SearchCalendarArgs.model_validate(raw_args)
    user = await context.session.get(User, context.owner_id)
    if user is None:
        raise LookupError("agent owner not found")
    time_range = args.time_range
    page = await CalendarRetriever.search(
        context.session,
        user,
        get_settings(),
        query=args.query,
        resource=args.resource,
        from_datetime=time_range.from_datetime if time_range else None,
        to_datetime=time_range.to_datetime if time_range else None,
        cursor=args.cursor,
        page_size=min(50, observation_limit),
    )
    return ToolExecutionResult(
        items=page.items,
        metadata={
            "total": page.total,
            "has_more": page.has_more,
            "next_cursor": page.next_cursor,
            "index_generation": page.index_generation,
            "thresholds": page.thresholds,
        },
    )


def default_tool_registry() -> Mapping[str, AgentTool]:
    tools = [
        AgentTool(
            "list_tasks",
            "List the current user's tasks, optionally in a half-open deadline range.",
            ListResourcesArgs,
            "read",
            _list_executor("task"),
        ),
        AgentTool(
            "get_task",
            "Get one current-user task by its UUID.",
            GetResourceArgs,
            "read",
            _get_executor("task"),
        ),
        AgentTool(
            "list_events",
            "List the current user's events, optionally in a half-open start-time range.",
            ListResourcesArgs,
            "read",
            _list_executor("event"),
        ),
        AgentTool(
            "get_event",
            "Get one current-user event by its UUID.",
            GetResourceArgs,
            "read",
            _get_executor("event"),
        ),
        AgentTool(
            "search_calendar",
            (
                "Search the current user's tasks and events by approximate title or description. "
                "Returns threshold-matched exact, substring, fuzzy and semantic evidence. "
                "Follow next_cursor while has_more is true if no confident match has been found."
            ),
            SearchCalendarArgs,
            "read",
            _search_executor,
        ),
        AgentTool(
            "show_calendar_items",
            (
                "Select already observed tasks or events to display as user-facing cards. "
                "Internal read results are never displayed automatically. Call this in a "
                "separate step after reads and before the terminal response."
            ),
            ShowCalendarItemsArgs,
            "presentation",
        ),
        AgentTool(
            "finish_response",
            "Finish after reads or answer without changing calendar data.",
            FinishResponseArgs,
            "terminal",
        ),
        AgentTool(
            "request_clarification",
            "Ask the user for a genuinely missing or ambiguous fact; do not change data.",
            RequestClarificationArgs,
            "terminal",
        ),
        AgentTool(
            "commit_calendar_command",
            "Atomically apply the final validated calendar mutations and finish.",
            CommitCalendarCommandArgs,
            "terminal",
        ),
    ]
    return {tool.name: tool for tool in tools}
