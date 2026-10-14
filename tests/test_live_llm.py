import os
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from planner.agent import _complete, build_system_prompt, parse_decision


pytestmark = pytest.mark.skipif(
    os.getenv("PLANNER_LIVE_LLM_TEST") != "1",
    reason="set PLANNER_LIVE_LLM_TEST=1 to call the configured model",
)


@pytest.mark.asyncio
async def test_live_qwen_returns_valid_planner_decisions() -> None:
    local_now = datetime(2026, 10, 14, 12, 0, tzinfo=ZoneInfo("Europe/Moscow"))
    prompt = build_system_prompt(local_now, "Europe/Moscow")

    read = parse_decision(await _complete("покажи задачи", system_prompt=prompt))
    assert any(item.operation == "list" and item.resource == "task" for item in read.reads)

    task = parse_decision(await _complete("создай задачу Купить молоко", system_prompt=prompt))
    assert any(item.operation == "create" and item.resource == "task" for item in task.mutations)

    event = parse_decision(
        await _complete("Запланируй встречу с Ильёй завтра в 13:00", system_prompt=prompt)
    )
    actions = [item for item in event.mutations if item.operation == "create" and item.resource == "event"]
    assert actions
    assert actions[0].payload.starts_at.isoformat() == "2026-10-15T13:00:00+03:00"
