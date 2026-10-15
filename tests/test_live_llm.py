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

    tomorrow = parse_decision(await _complete("Что у меня на завтра?", system_prompt=prompt))
    assert {item.resource for item in tomorrow.reads} == {"task", "event"}
    assert all(item.time_range is not None for item in tomorrow.reads)
    assert all(
        item.time_range.from_datetime.isoformat() == "2026-10-15T00:00:00+03:00"
        and item.time_range.to_datetime.isoformat() == "2026-10-16T00:00:00+03:00"
        for item in tomorrow.reads
    )

    task = parse_decision(await _complete("создай задачу Купить молоко", system_prompt=prompt))
    assert any(item.operation == "create" and item.resource == "task" for item in task.mutations)

    event = parse_decision(
        await _complete("Запланируй встречу с Ильёй завтра в 13:00", system_prompt=prompt)
    )
    actions = [
        item for item in event.mutations if item.operation == "create" and item.resource == "event"
    ]
    assert actions
    assert actions[0].payload.starts_at.isoformat() == "2026-10-15T13:00:00+03:00"


@pytest.mark.asyncio
async def test_live_qwen_preserves_unrequested_parts_of_referenced_task_title() -> None:
    local_now = datetime(2026, 10, 14, 17, 46, tzinfo=ZoneInfo("Europe/Moscow"))
    task_id = "893b93d2-12ab-4907-b990-a0e576635b06"
    history = [
        {"role": "user", "content": "Какие задачи мне нужно сделать за следующий месяц"},
        {
            "role": "assistant",
            "content": (
                '{"reply":"Вот задачи","reads":[{"resource":"task","id":"'
                + task_id
                + '","data":{"title":"Подготовить доклад на PyCon про tagless final"}}]}'
            ),
        },
    ]
    resource_context = [
        {
            "resource": "task",
            "id": task_id,
            "data": {
                "id": task_id,
                "title": "Подготовить доклад на PyCon про tagless final",
                "description": None,
                "deadline": "2026-10-19T15:00:00+00:00",
                "estimated_minutes": None,
                "status": "open",
            },
        }
    ]
    decision = parse_decision(
        await _complete(
            'Поменяй название конференции: она называется "pythonn"',
            system_prompt=build_system_prompt(local_now, "Europe/Moscow"),
            history=history,
            resource_context=resource_context,
        )
    )

    assert len(decision.mutations) == 1
    action = decision.mutations[0]
    assert action.operation == "update"
    assert str(action.target_id) == task_id
    assert action.payload.title == "Подготовить доклад на pythonn про tagless final"


@pytest.mark.asyncio
async def test_live_qwen_distinguishes_complete_rename_from_ambiguous_reference() -> None:
    local_now = datetime(2026, 10, 14, 17, 46, tzinfo=ZoneInfo("Europe/Moscow"))
    first_id = "893b93d2-12ab-4907-b990-a0e576635b06"
    second_id = "f16ded7d-54a3-4e97-b47f-9c950f338537"
    first = {
        "resource": "task",
        "id": first_id,
        "data": {"id": first_id, "title": "Доклад на PyCon", "status": "open"},
    }
    prompt = build_system_prompt(local_now, "Europe/Moscow")

    rename = parse_decision(
        await _complete(
            'Полностью переименуй задачу в "Готово к выступлению"',
            system_prompt=prompt,
            resource_context=[first],
        )
    )
    assert len(rename.mutations) == 1
    assert rename.mutations[0].payload.title == "Готово к выступлению"

    second = {
        "resource": "task",
        "id": second_id,
        "data": {"id": second_id, "title": "Билеты на PyCon", "status": "open"},
    }
    ambiguous = parse_decision(
        await _complete(
            'Поменяй название конференции на "pythonn"',
            system_prompt=prompt,
            resource_context=[first, second],
        )
    )
    assert ambiguous.clarification
    assert ambiguous.mutations == []
