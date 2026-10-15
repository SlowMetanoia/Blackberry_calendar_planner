import json

import pytest
from arq import Retry
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from planner import worker
from planner.agent import AgentResult, TranscriptionError
from planner.db import Base
from planner.models import AgentMessage, Conversation, MessageStatus, User


class FakeRedis:
    def __init__(self):
        self.values = {}
        self.jobs = []

    async def set(self, key, value, **kwargs):
        if kwargs.get("nx") and key in self.values:
            return False
        self.values[key] = value
        return True

    async def eval(self, script, count, key, token):
        if self.values.get(key) == token:
            self.values.pop(key)
            return 1
        return 0

    async def enqueue_job(self, name, *args, **kwargs):
        self.jobs.append((name, args, kwargs))
        return object()


@pytest.fixture
async def worker_db(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(worker, "SessionLocal", factory)
    yield factory
    await engine.dispose()


@pytest.mark.asyncio
async def test_messages_in_one_conversation_wait_for_previous(worker_db, monkeypatch) -> None:
    async with worker_db() as session:
        user = User(email="queue@example.test", password_hash="x")
        session.add(user)
        await session.flush()
        conversation = Conversation(owner_id=user.id)
        session.add(conversation)
        await session.flush()
        first = AgentMessage(
            owner_id=user.id,
            conversation_id=conversation.id,
            sequence=1,
            input_text="first",
            status=MessageStatus.queued,
        )
        second = AgentMessage(
            owner_id=user.id,
            conversation_id=conversation.id,
            sequence=2,
            input_text="second",
            status=MessageStatus.queued,
        )
        session.add_all([first, second])
        await session.commit()
        first_id, second_id = first.id, second.id

    async def completed(_text, _context=None):
        return AgentResult(
            "completed",
            json.dumps(
                {
                    "reply": "ok",
                    "reads": [],
                    "mutations": [],
                    "clarification": None,
                }
            ),
        )

    monkeypatch.setattr(worker, "run_agent", completed)
    redis = FakeRedis()
    with pytest.raises(Retry):
        await worker.process_message({"redis": redis, "job_try": 1}, str(second_id))
    await worker.process_message({"redis": redis, "job_try": 1}, str(first_id))
    await worker.process_message({"redis": redis, "job_try": 2}, str(second_id))

    async with worker_db() as session:
        assert (await session.get(AgentMessage, first_id)).status == MessageStatus.completed
        assert (await session.get(AgentMessage, second_id)).status == MessageStatus.completed


@pytest.mark.asyncio
async def test_different_conversations_use_different_locks(worker_db, monkeypatch) -> None:
    async with worker_db() as session:
        user = User(email="parallel@example.test", password_hash="x")
        session.add(user)
        await session.flush()
        first_conversation = Conversation(owner_id=user.id)
        second_conversation = Conversation(owner_id=user.id)
        session.add_all([first_conversation, second_conversation])
        await session.flush()
        messages = [
            AgentMessage(
                owner_id=user.id,
                conversation_id=first_conversation.id,
                sequence=1,
                input_text="first",
                status=MessageStatus.queued,
            ),
            AgentMessage(
                owner_id=user.id,
                conversation_id=second_conversation.id,
                sequence=1,
                input_text="second",
                status=MessageStatus.queued,
            ),
        ]
        session.add_all(messages)
        await session.commit()
        ids = [message.id for message in messages]

    async def completed(_text, _context=None):
        return AgentResult(
            "completed",
            json.dumps(
                {
                    "reply": "ok",
                    "reads": [],
                    "mutations": [],
                    "clarification": None,
                }
            ),
        )

    monkeypatch.setattr(worker, "run_agent", completed)
    redis = FakeRedis()
    for message_id in ids:
        await worker.process_message({"redis": redis, "job_try": 1}, str(message_id))
    assert redis.values == {}


@pytest.mark.asyncio
async def test_transcription_failure_is_safe_and_does_not_run_agent(worker_db, monkeypatch) -> None:
    async with worker_db() as session:
        user = User(email="voice-error@example.test", password_hash="x")
        session.add(user)
        await session.flush()
        conversation = Conversation(owner_id=user.id)
        session.add(conversation)
        await session.flush()
        message = AgentMessage(
            owner_id=user.id,
            conversation_id=conversation.id,
            sequence=1,
            audio_path="/tmp/message.webm",
            status=MessageStatus.queued,
        )
        session.add(message)
        await session.commit()
        message_id = message.id

    safe_error = (
        "Не удалось связаться с сервисом распознавания речи. "
        "Проверьте, что GigaAM запущен, и попробуйте записать сообщение ещё раз."
    )

    async def failed_transcription(_path):
        raise TranscriptionError(safe_error)

    monkeypatch.setattr(worker, "transcribe", failed_transcription)

    async def unexpected_agent(*_args, **_kwargs):
        pytest.fail("LLM must not run after a transcription failure")

    monkeypatch.setattr(worker, "run_agent", unexpected_agent)
    await worker.process_message({"redis": FakeRedis(), "job_try": 1}, str(message_id))

    async with worker_db() as session:
        stored = await session.get(AgentMessage, message_id)
        assert stored.status == MessageStatus.failed
        assert stored.error == safe_error


@pytest.mark.asyncio
async def test_unexpected_worker_error_does_not_leak_internal_details(
    worker_db, monkeypatch
) -> None:
    async with worker_db() as session:
        user = User(email="safe-worker@example.test", password_hash="x")
        session.add(user)
        await session.flush()
        conversation = Conversation(owner_id=user.id)
        session.add(conversation)
        await session.flush()
        message = AgentMessage(
            owner_id=user.id,
            conversation_id=conversation.id,
            sequence=1,
            input_text="сломайся",
            status=MessageStatus.queued,
        )
        session.add(message)
        await session.commit()
        message_id = message.id

    async def explode(*_args, **_kwargs):
        raise RuntimeError("INSERT INTO tasks secret_database_password")

    monkeypatch.setattr(worker, "run_agent", explode)
    with pytest.raises(RuntimeError):
        await worker.process_message({"redis": FakeRedis(), "job_try": 1}, str(message_id))

    async with worker_db() as session:
        stored = await session.get(AgentMessage, message_id)
        assert stored.status == MessageStatus.failed
        assert stored.error == "Не удалось обработать сообщение. Попробуйте ещё раз."
        assert "INSERT" not in stored.error
