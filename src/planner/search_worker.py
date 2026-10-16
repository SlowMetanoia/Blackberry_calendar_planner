import logging
import uuid
from typing import ClassVar

from arq.connections import RedisSettings
from sqlalchemy import or_, select

from .config import get_settings
from .db import SessionLocal
from .embeddings import EmbeddingClient
from .models import CalendarSearchDocument, CalendarSearchIndexState

logger = logging.getLogger(__name__)
RELEASE_LOCK_SCRIPT = """
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
"""


async def index_owner_calendar(ctx: dict, owner_id: str) -> None:
    settings = get_settings()
    owner_uuid = uuid.UUID(owner_id)
    redis = ctx["redis"]
    lock_key = f"calendar-index:{owner_id}"
    token = str(uuid.uuid4())
    acquired = await redis.set(lock_key, token, nx=True, px=300_000)
    if not acquired:
        return
    try:
        client = EmbeddingClient(settings)
        while True:
            async with SessionLocal() as session:
                state = await session.get(CalendarSearchIndexState, owner_uuid)
                if state is None:
                    return
                state.status = "indexing"
                state.error = None
                generation = state.requested_generation
                await session.commit()

                while True:
                    documents = list(
                        (
                            await session.scalars(
                                select(CalendarSearchDocument)
                                .where(
                                    CalendarSearchDocument.owner_id == owner_uuid,
                                    or_(
                                        CalendarSearchDocument.embedding.is_(None),
                                        CalendarSearchDocument.embedding_model
                                        != settings.embedding_model,
                                        CalendarSearchDocument.embedding_content_hash
                                        != CalendarSearchDocument.content_hash,
                                    ),
                                )
                                .order_by(
                                    CalendarSearchDocument.resource,
                                    CalendarSearchDocument.target_id,
                                )
                                .limit(settings.embedding_batch_size)
                            )
                        ).all()
                    )
                    if not documents:
                        break
                    hashes = [document.content_hash for document in documents]
                    vectors = await client.embed_documents(
                        [
                            (document.normalized_title, document.normalized_description)
                            for document in documents
                        ]
                    )
                    for document, content_hash, vector in zip(
                        documents, hashes, vectors, strict=True
                    ):
                        current = await session.get(
                            CalendarSearchDocument,
                            (document.owner_id, document.resource, document.target_id),
                            populate_existing=True,
                        )
                        if current is not None and current.content_hash == content_hash:
                            current.embedding = vector
                            current.embedding_model = settings.embedding_model
                            current.embedding_content_hash = content_hash
                    await session.commit()

                state = await session.get(
                    CalendarSearchIndexState, owner_uuid, populate_existing=True
                )
                if state.requested_generation != generation:
                    continue
                state.completed_generation = generation
                state.status = "ready"
                state.error = None
                await session.commit()
                return
    except Exception as exc:
        logger.exception("Calendar indexing failed for owner %s", owner_id)
        async with SessionLocal() as session:
            state = await session.get(CalendarSearchIndexState, owner_uuid)
            if state is not None:
                state.status = "failed"
                state.error = type(exc).__name__
                await session.commit()
        raise
    finally:
        await redis.eval(RELEASE_LOCK_SCRIPT, 1, lock_key, token)


class SearchWorkerSettings:
    functions: ClassVar[list] = [index_owner_calendar]
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
    queue_name = "calendar-index"
    max_jobs = 4
    max_tries = 3
    job_completion_wait = 300
