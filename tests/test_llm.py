import httpx
import pytest

from planner import llm
from planner.config import Settings


class FakeResponse:
    def __init__(self, body: dict, status_code: int = 200):
        self.body = body
        self.status_code = status_code
        self.request = httpx.Request("GET", "http://lm.test/v1/models")

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("bad status", request=self.request, response=self)

    def json(self) -> dict:
        return self.body


class FakeClient:
    def __init__(self, response=None, error=None, **_kwargs):
        self.response = response
        self.error = error
        self.headers = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def get(self, _url, headers=None):
        self.headers = headers
        if self.error:
            raise self.error
        return self.response


def settings(**overrides) -> Settings:
    values = {
        "llm_base_url": "http://lm.test",
        "llm_model": "qwen/qwen3.8-27b",
        "llm_required": True,
    }
    values.update(overrides)
    return Settings(**values)


def test_normalize_base_url_accepts_root_and_v1() -> None:
    assert llm.normalize_base_url("http://localhost:1234") == "http://localhost:1234/v1"
    assert llm.normalize_base_url("http://localhost:1234/v1/") == "http://localhost:1234/v1"


def test_qwen_payload_disables_thinking_and_uses_json_schema() -> None:
    payload = llm.completion_payload(settings(), [{"role": "user", "content": "test"}])
    assert payload["reasoning_effort"] == "none"
    assert "chat_template_kwargs" not in payload
    assert payload["temperature"] == 0
    assert payload["top_p"] == 1
    assert "presence_penalty" not in payload
    assert payload["stream"] is False
    assert payload["response_format"]["type"] == "json_schema"
    schema = payload["response_format"]["json_schema"]["schema"]
    assert {"reply", "reads", "mutations", "clarification"} <= set(schema["properties"])


def test_react_payload_uses_tools_without_json_response_format() -> None:
    tools = [
        {
            "type": "function",
            "function": {"name": "finish_response", "parameters": {"type": "object"}},
        }
    ]
    payload = llm.react_completion_payload(settings(), [{"role": "user", "content": "test"}], tools)
    assert payload["tools"] == tools
    assert payload["tool_choice"] == "auto"
    assert "response_format" not in payload


def test_empty_api_key_omits_authorization_header() -> None:
    assert "Authorization" not in llm.auth_headers(settings(llm_api_key=None))


@pytest.mark.asyncio
async def test_startup_probe_accepts_configured_model(monkeypatch) -> None:
    response = FakeResponse({"data": [{"id": "qwen/qwen3.8-27b"}]})
    monkeypatch.setattr(llm.httpx, "AsyncClient", lambda **kwargs: FakeClient(response, **kwargs))
    await llm.verify_llm_connection(settings())


@pytest.mark.asyncio
async def test_startup_probe_rejects_missing_model(monkeypatch) -> None:
    response = FakeResponse({"data": [{"id": "another-model"}]})
    monkeypatch.setattr(llm.httpx, "AsyncClient", lambda **kwargs: FakeClient(response, **kwargs))
    with pytest.raises(RuntimeError, match="another-model"):
        await llm.verify_llm_connection(settings())


@pytest.mark.asyncio
async def test_startup_probe_rejects_unreachable_server(monkeypatch) -> None:
    request = httpx.Request("GET", "http://lm.test/v1/models")
    error = httpx.ConnectError("down", request=request)
    monkeypatch.setattr(
        llm.httpx, "AsyncClient", lambda **kwargs: FakeClient(error=error, **kwargs)
    )
    with pytest.raises(RuntimeError, match="unavailable"):
        await llm.verify_llm_connection(settings())
