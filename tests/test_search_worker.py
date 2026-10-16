import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from planner import search_worker
from planner.calendar import CalendarCommandService, CalendarMutation
from planner.config import Settings
from planner.db import Base
from planner.models import CalendarSearchDocument, CalendarSearchIndexState, User


class FakeRedis:
    def __init__(self):
        self.values = {}

    async def set(self, key, value, **kwargs):
        if kwargs.get("nx") and key in self.values:
            return False
        self.values[key] = value
        return True

    async def eval(self, _script, _count, key, token):
        if self.values.get(key) == token:
            self.values.pop(key)
            return 1
        return 0


@pytest.mark.asyncio
async def test_indexer_completes_owner_generation(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        user = User(email="index@example.test", password_hash="x")
        session.add(user)
        await session.flush()
        await CalendarCommandService.execute(
            session,
            user,
            [CalendarMutation("create", "task", {"title": "Доклад"})],
            origin="rest",
        )
        await session.commit()
        owner_id = user.id

    settings = Settings(
        llm_required=False,
        embedding_base_url="http://lm.test",
        embedding_model="test-model",
        embedding_dimensions=768,
    )

    async def embed(_self, documents):
        return [[1.0, *([0.0] * 767)] for _document in documents]

    monkeypatch.setattr(search_worker, "SessionLocal", factory)
    monkeypatch.setattr(search_worker, "get_settings", lambda: settings)
    monkeypatch.setattr(search_worker.EmbeddingClient, "embed_documents", embed)
    redis = FakeRedis()

    await search_worker.index_owner_calendar({"redis": redis}, str(owner_id))

    async with factory() as session:
        state = await session.get(CalendarSearchIndexState, owner_id)
        document = (
            await session.scalars(
                select(CalendarSearchDocument).where(CalendarSearchDocument.owner_id == owner_id)
            )
        ).first()
        assert state.status == "ready"
        assert state.completed_generation == state.requested_generation == 1
        assert document.embedding_model == "test-model"
        assert document.embedding_content_hash == document.content_hash
    assert redis.values == {}
    await engine.dispose()
