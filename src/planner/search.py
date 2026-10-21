import asyncio
import base64
import binascii
import hashlib
import json
import math
import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from arq import create_pool
from arq.connections import RedisSettings
from sqlalchemy import and_, delete, func, literal, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from .config import Settings
from .embeddings import EmbeddingClient, EmbeddingError
from .models import (
    CalendarOccurrenceException,
    CalendarSearchDocument,
    CalendarSearchIndexState,
    Event,
    Reminder,
    Task,
    User,
)
from .occurrences import OccurrenceService, aware_utc
from .services import normalize_datetime

ResourceFilter = Literal["all", "task", "event", "reminder"]
MATCH_ORDER = {"exact": 0, "substring": 1, "fuzzy": 2, "semantic": 3}


class SearchCursorStale(ValueError):
    pass


class SearchIndexUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class SearchPage:
    items: list[dict[str, Any]]
    total: int
    has_more: bool
    next_cursor: str | None
    index_generation: int
    thresholds: dict[str, float]


def normalize_search_text(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").strip().lower().replace("ё", "е"))


def search_content_hash(title: str | None, description: str | None) -> str:
    content = f"{normalize_search_text(title)}\n{normalize_search_text(description)}"
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


async def sync_search_document(
    session: AsyncSession,
    owner_id: uuid.UUID,
    resource: str,
    target_id: uuid.UUID,
    snapshot: dict[str, Any] | None,
) -> None:
    key = (owner_id, resource, target_id)
    current = await session.get(CalendarSearchDocument, key)
    if snapshot is None:
        if current is not None:
            await session.delete(current)
        return
    title = str(snapshot.get("title") or "")
    description = str(snapshot.get("description") or "")
    content_hash = search_content_hash(title, description)
    if current is None:
        session.add(
            CalendarSearchDocument(
                owner_id=owner_id,
                resource=resource,
                target_id=target_id,
                normalized_title=normalize_search_text(title),
                normalized_description=normalize_search_text(description),
                content_hash=content_hash,
            )
        )
        return
    current.normalized_title = normalize_search_text(title)
    current.normalized_description = normalize_search_text(description)
    if current.content_hash != content_hash:
        current.content_hash = content_hash
        current.embedding = None
        current.embedding_model = None
        current.embedding_content_hash = None


async def mark_search_index_dirty(
    session: AsyncSession, owner_id: uuid.UUID
) -> CalendarSearchIndexState:
    state = await session.get(CalendarSearchIndexState, owner_id)
    if state is None:
        state = CalendarSearchIndexState(owner_id=owner_id)
        session.add(state)
        await session.flush()
    state.requested_generation += 1
    state.status = "pending"
    state.error = None
    await session.flush()
    return state


def _trigrams(value: str) -> set[str]:
    words = re.findall(r"\w+", value, flags=re.UNICODE)
    return {
        padded[index : index + 3]
        for word in words
        for padded in (f"  {word} ",)
        for index in range(max(0, len(padded) - 2))
    }


def _strict_word_similarity(query: str, text: str) -> float:
    query_parts = query.split()
    text_parts = text.split()
    if not query_parts or not text_parts:
        return 0.0
    width = min(len(query_parts), len(text_parts))
    query_trigrams = _trigrams(query)
    scores = []
    for index in range(len(text_parts) - width + 1):
        candidate = _trigrams(" ".join(text_parts[index : index + width]))
        denominator = max(len(query_trigrams), len(candidate), 1)
        scores.append(len(query_trigrams & candidate) / denominator)
    return max(scores, default=0.0)


def _cosine(left: list[float], right: list[float]) -> float:
    if len(left) != len(right):
        return -1.0
    denominator = math.sqrt(sum(item * item for item in left)) * math.sqrt(
        sum(item * item for item in right)
    )
    return (
        sum(a * b for a, b in zip(left, right, strict=True)) / denominator if denominator else -1.0
    )


def _resource_dict(resource: str, row: Task | Event) -> dict[str, Any]:
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


def _cursor_fingerprint(
    query: str,
    resource: ResourceFilter,
    from_datetime: datetime | None,
    to_datetime: datetime | None,
) -> str:
    raw = json.dumps(
        [query, resource, str(from_datetime), str(to_datetime)],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(raw.encode()).hexdigest()


def _encode_cursor(offset: int, generation: int, fingerprint: str) -> str:
    raw = json.dumps([offset, generation, fingerprint], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[int, int, str]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        offset, generation, fingerprint = json.loads(raw)
        offset_value = int(offset)
        generation_value = int(generation)
        if offset_value < 0 or generation_value < 0:
            raise ValueError("negative cursor values")
        return offset_value, generation_value, str(fingerprint)
    except (binascii.Error, UnicodeDecodeError, ValueError, TypeError, json.JSONDecodeError) as exc:
        raise SearchCursorStale("Некорректный cursor поиска") from exc


class CalendarRetriever:
    @classmethod
    async def search(
        cls,
        session: AsyncSession,
        user: User,
        settings: Settings,
        **kwargs: Any,
    ) -> SearchPage:
        generation = await ensure_search_index_ready(session, user, settings)
        query = str(kwargs["query"])
        try:
            query_embedding = await EmbeddingClient(settings).embed_query(query)
        except EmbeddingError as exc:
            raise SearchIndexUnavailable(str(exc)) from exc
        return await cls.search_ready(
            session,
            user,
            query_embedding=query_embedding,
            embedding_model=settings.embedding_model,
            index_generation=generation,
            fuzzy_threshold=settings.search_fuzzy_threshold,
            semantic_threshold=settings.search_semantic_threshold,
            **kwargs,
        )

    @classmethod
    async def search_ready(
        cls,
        session: AsyncSession,
        user: User,
        *,
        query: str,
        query_embedding: list[float],
        embedding_model: str,
        index_generation: int,
        resource: ResourceFilter = "all",
        from_datetime: datetime | None = None,
        to_datetime: datetime | None = None,
        cursor: str | None = None,
        page_size: int = 50,
        fuzzy_threshold: float = 0.5,
        semantic_threshold: float = 0.34,
    ) -> SearchPage:
        normalized_query = normalize_search_text(query)
        if not normalized_query:
            raise ValueError("query must not be blank")
        fingerprint = _cursor_fingerprint(normalized_query, resource, from_datetime, to_datetime)
        offset = 0
        if cursor:
            offset, cursor_generation, cursor_fingerprint = _decode_cursor(cursor)
            if cursor_generation != index_generation or cursor_fingerprint != fingerprint:
                raise SearchCursorStale("Индекс или параметры поиска изменились")

        conditions = [CalendarSearchDocument.owner_id == user.id]
        if resource != "all":
            conditions.append(CalendarSearchDocument.resource == resource)
        if session.get_bind().dialect.name == "postgresql":
            await session.execute(
                text(
                    "SELECT set_config('pg_trgm.strict_word_similarity_threshold', "
                    ":threshold, true)"
                ),
                {"threshold": str(fuzzy_threshold)},
            )
            query_value = literal(normalized_query)
            semantic_score = 1 - CalendarSearchDocument.embedding.cosine_distance(query_embedding)
            semantic_match = and_(
                CalendarSearchDocument.embedding.is_not(None),
                CalendarSearchDocument.embedding_model == embedding_model,
                CalendarSearchDocument.embedding_content_hash
                == CalendarSearchDocument.content_hash,
                semantic_score >= semantic_threshold,
            )
            title_fuzzy = query_value.op("<<%")(CalendarSearchDocument.normalized_title)
            description_fuzzy = query_value.op("<<%")(CalendarSearchDocument.normalized_description)
            conditions.append(
                or_(
                    CalendarSearchDocument.normalized_title == normalized_query,
                    CalendarSearchDocument.normalized_description == normalized_query,
                    CalendarSearchDocument.normalized_title.contains(normalized_query),
                    CalendarSearchDocument.normalized_description.contains(normalized_query),
                    title_fuzzy if len(normalized_query) >= 3 else False,
                    description_fuzzy if len(normalized_query) >= 3 else False,
                    semantic_match,
                )
            )
        documents = list(
            (await session.scalars(select(CalendarSearchDocument).where(*conditions))).all()
        )
        found: list[dict[str, Any]] = []
        normalized_from = normalize_datetime(from_datetime, user)
        normalized_to = normalize_datetime(to_datetime, user)
        for document in documents:
            model = {"task": Task, "event": Event, "reminder": Reminder}[document.resource]
            row_conditions = [model.id == document.target_id, model.owner_id == user.id]
            row = await session.scalar(select(model).where(*row_conditions))
            if row is None:
                continue

            occurrence_page = None
            if document.resource == "reminder" and (
                normalized_from is not None or normalized_to is not None
            ):
                if normalized_from is not None and aware_utc(row.remind_at) < normalized_from:
                    continue
                if normalized_to is not None and aware_utc(row.remind_at) >= normalized_to:
                    continue
            elif normalized_from is not None or normalized_to is not None:
                occurrence_page = await OccurrenceService.page(
                    session,
                    user,
                    resource=document.resource,
                    series_id=document.target_id,
                    from_datetime=normalized_from,
                    to_datetime=normalized_to,
                    limit=100,
                )
                if occurrence_page.total == 0:
                    continue
            elif document.resource != "reminder" and getattr(row, "recurrence", None) is not None:
                occurrence_page = await OccurrenceService.preview(
                    session,
                    user,
                    resource=document.resource,
                    series_id=document.target_id,
                    limit=5,
                )

            matches: list[dict[str, Any]] = []
            for field, value in (
                ("title", document.normalized_title),
                ("description", document.normalized_description),
            ):
                if not value:
                    continue
                if normalized_query == value:
                    matches.append({"kind": "exact", "field": field})
                if normalized_query in value:
                    matches.append({"kind": "substring", "field": field})
                if len(normalized_query) >= 3:
                    score = _strict_word_similarity(normalized_query, value)
                    if score >= fuzzy_threshold:
                        matches.append(
                            {
                                "kind": "fuzzy",
                                "field": field,
                                "score": round(score, 6),
                                "threshold": fuzzy_threshold,
                            }
                        )
            if (
                document.embedding is not None
                and document.embedding_model == embedding_model
                and document.embedding_content_hash == document.content_hash
            ):
                semantic_score = _cosine(list(query_embedding), list(document.embedding))
                if semantic_score >= semantic_threshold:
                    matches.append(
                        {
                            "kind": "semantic",
                            "field": "title_description",
                            "score": round(semantic_score, 6),
                            "threshold": semantic_threshold,
                        }
                    )
            if not matches:
                continue
            item = _resource_dict(document.resource, row)
            if occurrence_page is not None:
                item["data"]["occurrence_dates"] = [
                    value.scheduled_at.isoformat() for value in occurrence_page.items
                ]
                item["data"]["occurrence_total"] = occurrence_page.total
                item["data"]["occurrence_has_more"] = occurrence_page.has_more
                item["data"]["occurrence_cursor"] = occurrence_page.next_cursor
            item["matches"] = matches
            best_order = min(MATCH_ORDER[match["kind"]] for match in matches)
            best_score = max(float(match.get("score", 1.0)) for match in matches)
            found.append(
                {
                    "item": item,
                    "sort": (
                        best_order,
                        0 if any(match["field"] == "title" for match in matches) else 1,
                        -best_score,
                        document.resource,
                        document.normalized_title,
                        str(document.target_id),
                    ),
                }
            )
        found.sort(key=lambda value: value["sort"])
        total = len(found)
        items = [value["item"] for value in found[offset : offset + page_size]]
        next_offset = offset + len(items)
        has_more = next_offset < total
        return SearchPage(
            items=items,
            total=total,
            has_more=has_more,
            next_cursor=_encode_cursor(next_offset, index_generation, fingerprint)
            if has_more
            else None,
            index_generation=index_generation,
            thresholds={"fuzzy": fuzzy_threshold, "semantic": semantic_threshold},
        )


async def rebuild_search_documents(session: AsyncSession, user: User) -> None:
    await session.execute(
        delete(CalendarSearchDocument).where(CalendarSearchDocument.owner_id == user.id)
    )
    for resource, model in (("task", Task), ("event", Event), ("reminder", Reminder)):
        rows = list((await session.scalars(select(model).where(model.owner_id == user.id))).all())
        for row in rows:
            overrides = list(
                (
                    await session.scalars(
                        select(CalendarOccurrenceException).where(
                            CalendarOccurrenceException.owner_id == user.id,
                            CalendarOccurrenceException.resource == resource,
                            CalendarOccurrenceException.series_id == row.id,
                            CalendarOccurrenceException.cancelled.is_(False),
                        )
                    )
                ).all()
            )
            aliases = sorted(
                {
                    str(value)
                    for item in overrides
                    for field in ("title", "description")
                    if (value := (item.patch or {}).get(field))
                }
            )
            await sync_search_document(
                session,
                user.id,
                resource,
                row.id,
                {
                    "title": row.title,
                    "description": "\n".join(
                        value for value in [row.description or "", *aliases] if value
                    ),
                },
            )
    await mark_search_index_dirty(session, user.id)


async def schedule_calendar_index(owner_id: uuid.UUID, settings: Settings) -> None:
    try:
        pool = await create_pool(RedisSettings.from_dsn(settings.redis_url))
        try:
            await pool.enqueue_job(
                "index_owner_calendar",
                str(owner_id),
                _queue_name="calendar-index",
            )
        finally:
            await pool.close()
    except Exception as exc:
        raise SearchIndexUnavailable("Не удалось поставить индексирование в очередь") from exc


async def _stale_document_count(session: AsyncSession, owner_id: uuid.UUID, model: str) -> int:
    return int(
        await session.scalar(
            select(func.count())
            .select_from(CalendarSearchDocument)
            .where(
                CalendarSearchDocument.owner_id == owner_id,
                or_(
                    CalendarSearchDocument.embedding.is_(None),
                    CalendarSearchDocument.embedding_model != model,
                    CalendarSearchDocument.embedding_content_hash
                    != CalendarSearchDocument.content_hash,
                ),
            )
        )
        or 0
    )


async def ensure_search_index_ready(session: AsyncSession, user: User, settings: Settings) -> int:
    state = await session.get(CalendarSearchIndexState, user.id)
    stale = await _stale_document_count(session, user.id, settings.embedding_model)
    if state is None:
        if stale == 0:
            return 0
        state = await mark_search_index_dirty(session, user.id)
        await session.commit()
    elif stale and state.completed_generation >= state.requested_generation:
        state = await mark_search_index_dirty(session, user.id)
        await session.commit()
    if (
        state.status == "ready"
        and state.completed_generation >= state.requested_generation
        and stale == 0
    ):
        return state.completed_generation

    await schedule_calendar_index(user.id, settings)
    deadline = asyncio.get_running_loop().time() + settings.embedding_index_wait_seconds
    while asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.1)
        state = await session.get(CalendarSearchIndexState, user.id, populate_existing=True)
        if state is None:
            continue
        if state.status == "failed":
            raise SearchIndexUnavailable("Индекс календаря не удалось построить")
        if (
            state.status == "ready"
            and state.completed_generation >= state.requested_generation
            and await _stale_document_count(session, user.id, settings.embedding_model) == 0
        ):
            return state.completed_generation
    raise SearchIndexUnavailable("Индекс календаря не успел обновиться")
