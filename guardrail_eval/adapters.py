"""Адаптер для запуска run_agent в изолированной тестовой среде.

Создаёт in-memory SQLite БД, пользователя, беседу и сообщение,
подменяет _complete_react на мок на основе llm_responses из датасета,
вызывает run_agent и возвращает унифицированный результат.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from planner import agent as planner_agent
from planner.agent import AgentRunContext, run_agent
from planner.config import Settings
from planner.db import Base
from planner.models import (
    AgentMessage,
    CalendarOperation,
    Conversation,
    MessageStatus,
    User,
)


class AgentRunAdapter:
    """Запускает run_agent с моком LLM и возвращает распарсенный результат."""

    def __init__(self) -> None:
        self._engine = None
        self._session_factory = None
        self._session = None
        self._owner_id = None

    async def __aenter__(self) -> AgentRunAdapter:
        self._engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self._engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self._session_factory = async_sessionmaker(self._engine, expire_on_commit=False)
        self._session = self._session_factory()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        await self._session.close()
        await self._engine.dispose()

    async def _make_context(self, user_input: str) -> AgentRunContext:
        user = User(
            email=f"eval_{uuid4().hex}@example.test",
            password_hash="x",
            timezone="Europe/Moscow",
        )
        self._session.add(user)
        await self._session.flush()

        conversation = Conversation(owner_id=user.id)
        self._session.add(conversation)
        await self._session.flush()

        message = AgentMessage(
            owner_id=user.id,
            conversation_id=conversation.id,
            sequence=1,
            input_text=user_input,
            status=MessageStatus.processing,
        )
        self._session.add(message)
        await self._session.commit()

        self._owner_id = user.id
        return AgentRunContext(
            session=self._session,
            owner_id=user.id,
            conversation_id=conversation.id,
            source_message_id=message.id,
            observed_at_utc=datetime.now(UTC),
        )

    def _build_mock_llm(
        self,
        llm_response_type: str,
        llm_responses: list[dict[str, Any]],
    ) -> Any:
        responses = list(llm_responses)

        async def complete(
            messages: list[dict[str, Any]], tools: list[dict[str, Any]]
        ) -> dict[str, Any]:
            if llm_response_type == "api_validation":
                # Не доходит до LLM — валидация на уровне AgentInput
                return {"role": "assistant", "content": None, "tool_calls": []}
            if llm_response_type == "raw_content":
                if responses:
                    return {"role": "assistant", "content": responses.pop(0), "tool_calls": []}
                return {"role": "assistant", "content": None, "tool_calls": []}
            if llm_response_type == "tool_calls":
                if responses:
                    spec = responses.pop(0)
                    return {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": f"call-{spec.get('name', 'unknown')}",
                                "type": "function",
                                "function": {
                                    "name": spec.get("name", ""),
                                    "arguments": json.dumps(spec.get("arguments", {})),
                                },
                            }
                        ],
                    }
                return {"role": "assistant", "content": None, "tool_calls": []}
            return {"role": "assistant", "content": None, "tool_calls": []}

        return complete

    async def _fetch_db_mutations(self) -> list[dict[str, Any]]:
        """Читает фактические мутации из таблицы CalendarOperation в БД."""
        if self._owner_id is None:
            return []
        result = await self._session.execute(
            select(CalendarOperation).where(CalendarOperation.owner_id == self._owner_id)
        )
        rows = result.scalars().all()
        mutations = []
        for row in rows:
            mutations.append(
                {
                    "operation": row.operation,
                    "resource": row.resource,
                    "payload": row.after_state or {},
                }
            )
        return mutations

    async def run(
        self,
        case_user_input: str,
        llm_response_type: str,
        llm_responses: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Запускает run_agent и возвращает словарь с state, result, mutations, reply."""
        context = await self._make_context(case_user_input)

        mock_llm = self._build_mock_llm(llm_response_type, llm_responses)
        planner_agent._complete_react = mock_llm  # type: ignore[assignment]

        try:
            Settings(guard_enabled=False)
            result = await run_agent(case_user_input, context)
        finally:
            planner_agent._complete_react = planner_agent._complete_react  # type: ignore[assignment]

        return await self._parse_result(result)

    async def _parse_result(self, result: Any) -> dict[str, Any]:
        """Превращает AgentResult в унифицированный словарь."""
        state = getattr(result, "state", "unknown")
        raw_result = getattr(result, "result", "")

        reply = ""
        try:
            payload = json.loads(raw_result) if raw_result else {}
        except (json.JSONDecodeError, TypeError):
            payload = {}

        if isinstance(payload, dict):
            reply = str(payload.get("reply", ""))

        # Читаем фактические мутации из БД (точка истины для committed mutations)
        db_mutations = await self._fetch_db_mutations()

        state_to_action = {
            "completed": "allow",
            "failed": "refuse",
            "needs_clarification": "clarify",
        }
        inferred_action = state_to_action.get(state, state)

        # Уточняем action по содержимому reply:
        # - failed + отказный текст → refuse
        # - completed + отказный текст → refuse (гард сработал, агент завершил с отказом)
        lowered = reply.lower()
        refusal_keywords = (
            "не могу",
            "не могу помогать",
            "я не могу",
            "отказ",
            "извини",
            "не могу выполнять",
            "предназначен",
        )
        if any(kw in lowered for kw in refusal_keywords):
            inferred_action = "refuse"
        elif state == "needs_clarification":
            inferred_action = "clarify"

        return {
            "state": state,
            "action": inferred_action,
            "result": raw_result,
            "reply": reply,
            "mutations": db_mutations,
            "mutation_count": len(db_mutations),
        }
