import json
import os
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from planner.agent import _complete_react, _tool_schemas, build_system_prompt
from planner.agent_tools import (
    CommitCalendarCommandArgs,
    FinishResponseArgs,
    ShowCalendarItemsArgs,
)

pytestmark = pytest.mark.skipif(
    os.getenv("PLANNER_LIVE_LLM_TEST") != "1",
    reason="set PLANNER_LIVE_LLM_TEST=1 to call the configured model",
)


def function_call(message: dict) -> tuple[dict, str, dict]:
    call = message["tool_calls"][0]
    function = call["function"]
    return call, function["name"], json.loads(function["arguments"])


@pytest.mark.asyncio
async def test_live_qwen_completes_read_observe_terminal_round_trip() -> None:
    local_now = datetime(2026, 10, 14, 12, 0, tzinfo=ZoneInfo("Europe/Moscow"))
    messages = [
        {
            "role": "system",
            "content": build_system_prompt(local_now, "Europe/Moscow"),
        },
        {"role": "user", "content": "покажи задачи"},
    ]
    tools = _tool_schemas()

    read_message = await _complete_react(messages, tools)
    read_call, read_name, _read_args = function_call(read_message)
    assert read_name == "list_tasks"

    messages.extend(
        [
            read_message,
            {
                "role": "tool",
                "tool_call_id": read_call["id"],
                "name": read_name,
                "content": json.dumps(
                    {
                        "ok": True,
                        "tool": "list_tasks",
                        "data": [
                            {
                                "resource": "task",
                                "id": "893b93d2-12ab-4907-b990-a0e576635b06",
                                "data": {"title": "Купить молоко", "status": "open"},
                            }
                        ],
                    },
                    ensure_ascii=False,
                ),
            },
        ]
    )
    show_message = await _complete_react(messages, tools)
    show_call, show_name, show_args = function_call(show_message)
    selection = ShowCalendarItemsArgs.model_validate(show_args)
    assert show_name == "show_calendar_items"
    assert [str(item.target_id) for item in selection.items] == [
        "893b93d2-12ab-4907-b990-a0e576635b06"
    ]

    messages.extend(
        [
            show_message,
            {
                "role": "tool",
                "tool_call_id": show_call["id"],
                "name": show_name,
                "content": json.dumps(
                    {
                        "ok": True,
                        "tool": "show_calendar_items",
                        "selected": [
                            {
                                "resource": "task",
                                "target_id": "893b93d2-12ab-4907-b990-a0e576635b06",
                            }
                        ],
                    }
                ),
            },
        ]
    )
    final_message = await _complete_react(messages, tools)
    _final_call, final_name, final_args = function_call(final_message)

    assert final_name == "finish_response"
    assert "молоко" in FinishResponseArgs.model_validate(final_args).reply.lower()


@pytest.mark.asyncio
async def test_live_qwen_uses_terminal_commit_for_create() -> None:
    local_now = datetime(2026, 10, 14, 12, 0, tzinfo=ZoneInfo("Europe/Moscow"))
    message = await _complete_react(
        [
            {
                "role": "system",
                "content": build_system_prompt(local_now, "Europe/Moscow"),
            },
            {"role": "user", "content": "создай задачу Купить молоко"},
        ],
        _tool_schemas(),
    )
    _call, name, args = function_call(message)
    command = CommitCalendarCommandArgs.model_validate(args)

    assert name == "commit_calendar_command"
    assert len(command.mutations) == 1
    assert command.mutations[0].operation == "create"
    assert command.mutations[0].resource == "task"
    assert command.mutations[0].payload.title == "Купить молоко"


@pytest.mark.asyncio
async def test_live_qwen_uses_hybrid_search_for_approximate_reference() -> None:
    local_now = datetime(2026, 10, 16, 12, 0, tzinfo=ZoneInfo("Europe/Moscow"))
    message = await _complete_react(
        [
            {
                "role": "system",
                "content": build_system_prompt(local_now, "Europe/Moscow"),
            },
            {
                "role": "user",
                "content": "Найди в календаре занятие по иностранному языку, кажется французский",
            },
        ],
        _tool_schemas(),
    )
    _call, name, args = function_call(message)

    assert name == "search_calendar"
    assert "француз" in args["query"].lower() or "язык" in args["query"].lower()
