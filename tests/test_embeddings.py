import httpx
import pytest

from planner import embeddings
from planner.config import Settings
from planner.embeddings import EmbeddingClient, EmbeddingError


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def raise_for_status(self):
        return None

    def json(self):
        return self.body


class FakeClient:
    def __init__(self, response, **_kwargs):
        self.response = response

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def post(self, _url, **_kwargs):
        return self.response


@pytest.mark.asyncio
async def test_embedding_client_formats_query_and_validates_dimensions(monkeypatch):
    seen = {}

    class RecordingClient(FakeClient):
        async def post(self, url, **kwargs):
            seen.update(url=url, **kwargs)
            return self.response

    response = FakeResponse({"data": [{"index": 0, "embedding": [1.0, 0.0, 0.0]}]})
    monkeypatch.setattr(
        embeddings.httpx,
        "AsyncClient",
        lambda **kwargs: RecordingClient(response, **kwargs),
    )
    settings = Settings(
        llm_required=False,
        embedding_base_url="http://lm.test",
        embedding_model="embedding-test",
        embedding_dimensions=3,
    )

    result = await EmbeddingClient(settings).embed_query("французский")

    assert result == [1.0, 0.0, 0.0]
    assert seen["url"] == "http://lm.test/v1/embeddings"
    assert seen["json"]["input"] == ["task: search result | query: французский"]
    assert seen["json"]["dimensions"] == 3


@pytest.mark.asyncio
async def test_embedding_client_reuses_llm_server_when_embedding_url_is_omitted(monkeypatch):
    seen = {}

    class RecordingClient(FakeClient):
        async def post(self, url, **kwargs):
            seen.update(url=url, **kwargs)
            return self.response

    response = FakeResponse({"data": [{"index": 0, "embedding": [1.0, 0.0, 0.0]}]})
    monkeypatch.setattr(
        embeddings.httpx,
        "AsyncClient",
        lambda **kwargs: RecordingClient(response, **kwargs),
    )
    settings = Settings(
        llm_required=False,
        llm_base_url="http://lm.test/v1",
        embedding_base_url=None,
        embedding_model="embedding-test",
        embedding_dimensions=3,
    )

    await EmbeddingClient(settings).embed_query("французский")

    assert seen["url"] == "http://lm.test/v1/embeddings"


@pytest.mark.asyncio
async def test_embedding_client_marks_calendar_records_as_search_documents(monkeypatch):
    seen = {}

    class RecordingClient(FakeClient):
        async def post(self, url, **kwargs):
            seen.update(url=url, **kwargs)
            return self.response

    response = FakeResponse({"data": [{"index": 0, "embedding": [1.0, 0.0, 0.0]}]})
    monkeypatch.setattr(
        embeddings.httpx,
        "AsyncClient",
        lambda **kwargs: RecordingClient(response, **kwargs),
    )
    settings = Settings(
        llm_required=False,
        embedding_base_url="http://lm.test",
        embedding_model="embedding-test",
        embedding_dimensions=3,
    )

    await EmbeddingClient(settings).embed_documents(
        [("Приём у стоматолога", "Плановый осмотр зубов")]
    )

    assert seen["json"]["input"] == [
        "task: search result | document: Приём у стоматолога. Плановый осмотр зубов"
    ]


@pytest.mark.asyncio
async def test_embedding_client_rejects_wrong_dimensions(monkeypatch):
    response = FakeResponse({"data": [{"index": 0, "embedding": [1.0]}]})
    monkeypatch.setattr(
        embeddings.httpx,
        "AsyncClient",
        lambda **kwargs: FakeClient(response, **kwargs),
    )
    settings = Settings(
        llm_required=False,
        embedding_base_url="http://lm.test",
        embedding_dimensions=3,
    )

    with pytest.raises(EmbeddingError, match="3 dimensions"):
        await EmbeddingClient(settings).embed(["text"])


@pytest.mark.asyncio
async def test_embedding_client_hides_transport_details(monkeypatch):
    class BrokenClient(FakeClient):
        async def post(self, url, **_kwargs):
            raise httpx.ConnectError("secret host", request=httpx.Request("POST", url))

    monkeypatch.setattr(
        embeddings.httpx,
        "AsyncClient",
        lambda **kwargs: BrokenClient(None, **kwargs),
    )
    settings = Settings(
        llm_required=False,
        embedding_base_url="http://lm.test",
        embedding_dimensions=3,
    )

    with pytest.raises(EmbeddingError) as error:
        await EmbeddingClient(settings).embed(["text"])
    assert "secret" not in str(error.value)
