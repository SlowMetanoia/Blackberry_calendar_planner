import math
import os

import pytest

from planner.config import Settings
from planner.embeddings import EmbeddingClient

pytestmark = pytest.mark.skipif(
    os.getenv("PLANNER_LIVE_EMBEDDING_TEST") != "1",
    reason="set PLANNER_LIVE_EMBEDDING_TEST=1 to use the local LM Studio server",
)


RUSSIAN_POSITIVE_PAIRS = [
    ("занятие французским", "Французский", "Урок иностранного языка"),
    ("конференция по python", "Подготовить доклад на PyCon", "Конференция разработчиков"),
    ("встреча по релизу", "Обсуждение выпуска", "Созвон команды перед выходом новой версии"),
    ("поход к врачу", "Приём у стоматолога", "Плановый осмотр зубов"),
    ("купить продукты", "Сходить в магазин", "Молоко, хлеб и овощи"),
]


def cosine_similarity(left: list[float], right: list[float]) -> float:
    dot = sum(a * b for a, b in zip(left, right, strict=True))
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    return dot / (left_norm * right_norm)


@pytest.mark.asyncio
async def test_embeddinggemma_keeps_all_russian_positive_pairs_above_threshold():
    settings = Settings(
        llm_required=False,
        embedding_base_url=os.getenv("EMBEDDING_BASE_URL", "http://127.0.0.1:1234/v1"),
        embedding_model="ggml-org/embeddinggemma-300M-GGUF",
        embedding_dimensions=768,
        search_semantic_threshold=0.34,
    )
    client = EmbeddingClient(settings)

    queries = await client.embed_query_batch([pair[0] for pair in RUSSIAN_POSITIVE_PAIRS])
    documents = await client.embed_documents(
        [(title, description) for _, title, description in RUSSIAN_POSITIVE_PAIRS]
    )
    scores = [
        cosine_similarity(query, document)
        for query, document in zip(queries, documents, strict=True)
    ]

    assert min(scores) >= settings.search_semantic_threshold, scores
