"""Live evaluation exercises the HTTP boundary; models stay mocked only in these tests."""

import json

import httpx
import pytest

from guardrail_eval.adapters import AgentRunAdapter
from guardrail_eval.classifier import ClassificationInput, classify
from guardrail_eval.cli import build_parser
from guardrail_eval.comparator import compare_reports
from guardrail_eval.live import LiveAgentAdapter, LiveEvaluationError
from guardrail_eval.loader import load_dataset
from guardrail_eval.models import EvalCase, GuardResult
from planner import agent


def make_case(**overrides):
    values = {
        "case_id": "create",
        "user_input": "create a task",
        "llm_response_type": "tool_calls",
        "llm_responses": [{"name": "must_not_be_used"}],
        "expected_action": "allow",
        "expected_category": "none",
        "expected_state": "completed",
        "expected_db_mutations": 1,
        "expected_reply_contains": None,
        "guard_source": "user_input",
        "requires_remote_guard": False,
    }
    values.update(overrides)
    return EvalCase(**values)


class PlannerHTTP:
    def __init__(self):
        self.requests = []
        self.polls = 0
        self.status = "completed"
        self.guard = {"action": "allow", "category": "none", "score": 0, "reason": ""}
        self.execution_error = None
        self.with_diagnostics = True
        self.model = "remote-test-model"
        self.validation = False

    def __call__(self, request):
        self.requests.append(request)
        path = request.url.path
        if path == "/health":
            return httpx.Response(200, json={"status": "ok"})
        if path == "/auth/register":
            return httpx.Response(201, json={"access_token": "private-test-token"})
        if path == "/auth/logout":
            return httpx.Response(204)
        if path == "/users/me/timezone":
            return httpx.Response(200, json={"timezone": "Europe/Moscow"})
        if path == "/events" and request.method == "POST":
            return httpx.Response(201, json={"id": "seed"})
        if path == "/agent/messages":
            if self.validation:
                return httpx.Response(422, json={"code": "validation_error"})
            return httpx.Response(202, json={"id": "message-1", "status": "queued"})
        if path == "/agent/messages/message-1":
            self.polls += 1
            if self.polls == 1:
                return httpx.Response(200, json={"id": "message-1", "status": "processing"})
            body = {"id": "message-1", "status": self.status, "reply": "done"}
            if self.with_diagnostics:
                body["diagnostics"] = {
                    "llm_model": self.model,
                    "model_turns": 1,
                    "guard_enabled": False,
                    "input_guard": self.guard,
                    "execution_error": self.execution_error,
                }
            return httpx.Response(200, json=body)
        if path == "/calendar/history":
            items = [
                {
                    "id": "op1",
                    "source_message_id": "message-1",
                    "operation": "create",
                    "resource": "task",
                    "after": {"title": "Milk"},
                },
                {
                    "id": "seed-op",
                    "source_message_id": None,
                    "operation": "create",
                    "resource": "event",
                    "after": {"title": "Existing meeting"},
                },
            ]
            return httpx.Response(200, json={"items": items, "total": len(items)})
        if path in {"/tasks", "/events"}:
            return httpx.Response(200, json={"items": [], "total": 0})
        raise AssertionError(f"Unexpected request {request.method} {request.url}")


@pytest.mark.asyncio
async def test_live_uses_api_polls_and_reads_history_without_using_local_llm(monkeypatch):
    async def forbidden(*args, **kwargs):
        raise AssertionError("local LLM must never be called by live adapter")

    monkeypatch.setattr(agent, "_complete_react", forbidden)
    server = PlannerHTTP()
    case = make_case(
        raw={"initial_events": [{"title": "Existing", "starts_at": "2026-10-20T13:00:00+03:00"}]}
    )
    async with LiveAgentAdapter(
        "http://planner", poll_interval=0.001, transport=httpx.MockTransport(server)
    ) as adapter:
        actual = await adapter.run_case(case)
    assert actual["mutation_count"] == 1
    assert actual["mutations"][0]["payload"]["title"] == "Milk"
    assert actual["diagnostics"]["llm_model"] == "remote-test-model"
    assert server.polls == 2
    assert any(r.method == "POST" and r.url.path == "/events" for r in server.requests)
    submission = next(r for r in server.requests if r.url.path == "/agent/messages")
    assert json.loads(submission.content) == {"text": case.user_input}
    assert "private-test-token" not in json.dumps(actual)
    assert agent._complete_react is forbidden


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["model", "guard", "old_server", "fake"])
async def test_live_reports_infrastructure_failures(failure):
    server = PlannerHTTP()
    if failure == "model":
        server.status = "failed"
        server.execution_error = "llm_http_error"
    elif failure == "guard":
        server.guard = {
            "action": "clarify",
            "category": "unsafe_other",
            "score": 1,
            "reason": "guard_unavailable",
        }
    elif failure == "old_server":
        server.with_diagnostics = False
    else:
        server.model = "fake-planner"
    async with LiveAgentAdapter(
        "http://planner", poll_interval=0.001, transport=httpx.MockTransport(server)
    ) as adapter:
        with pytest.raises(LiveEvaluationError):
            await adapter.run_case(make_case())


@pytest.mark.asyncio
async def test_live_timeout_is_bounded():
    server = PlannerHTTP()
    server.status = "processing"
    async with LiveAgentAdapter(
        "http://planner",
        case_timeout=0.01,
        poll_interval=0.001,
        transport=httpx.MockTransport(server),
    ) as adapter:
        with pytest.raises(LiveEvaluationError, match="[Tt]imeout"):
            await adapter.run_case(make_case())


@pytest.mark.asyncio
async def test_live_input_validation_does_not_need_a_model_call():
    server = PlannerHTTP()
    server.validation = True
    async with LiveAgentAdapter("http://planner", transport=httpx.MockTransport(server)) as adapter:
        actual = await adapter.run_case(
            make_case(
                user_input="  ",
                llm_response_type="api_validation",
                expected_category="input_validation",
            )
        )
    assert actual["state"] == "failed"
    assert actual["action"] == "refuse"
    assert actual["mutation_count"] == 0
    assert actual["http_status"] == 422


@pytest.mark.asyncio
async def test_mock_adapter_restores_completion_and_keeps_clarification():
    original = agent._complete_react
    async with AgentRunAdapter() as adapter:
        actual = await adapter.run(
            "recipe",
            "tool_calls",
            [{"name": "request_clarification", "arguments": {"question": "I cannot proceed"}}],
        )
    assert agent._complete_react is original
    assert actual["state"] == "needs_clarification"
    assert actual["action"] == "clarify"


def test_same_severity_still_reports_behavior_changes():
    before = {"cases": [{"case_id": "recipe", "severity": "bad", "actual": {"state": "failed"}}]}
    after = {
        "cases": [
            {"case_id": "recipe", "severity": "bad", "actual": {"state": "needs_clarification"}}
        ]
    }
    delta = compare_reports(before, after)
    assert delta["counts"]["behavior_changed"] == 1
    assert delta["counts"]["unchanged"] == 0


def test_live_dataset_does_not_require_scripted_model_responses(tmp_path):
    path = tmp_path / "cases.jsonl"
    record = vars(make_case()).copy()
    for key in ["llm_response_type", "llm_responses", "raw"]:
        record.pop(key)
    path.write_text(json.dumps(record), encoding="utf-8")
    assert load_dataset(path)[0].llm_responses == []
    args = build_parser().parse_args(
        ["run", "--live", "--dataset", str(path), "--api-url", "http://planner"]
    )
    assert args.live is True


def test_expected_payload_is_checked_even_when_mutation_count_matches():
    case = make_case(
        raw={
            "expected_mutations": [
                {"operation": "create", "resource": "task", "payload": {"title": "Milk"}}
            ]
        }
    )
    actual = {
        "state": "completed",
        "action": "allow",
        "mutation_count": 1,
        "mutations": [{"operation": "create", "resource": "task", "payload": {"title": "Wrong"}}],
    }
    verdict = classify(ClassificationInput(case, actual, GuardResult()))
    assert verdict.severity.value == "bad"
    assert "mutation payload mismatch" in " ".join(verdict.issues)


@pytest.mark.asyncio
async def test_each_live_case_gets_a_separate_owner():
    server = PlannerHTTP()
    async with LiveAgentAdapter(
        "http://planner", poll_interval=0.001, transport=httpx.MockTransport(server)
    ) as adapter:
        await adapter.run_case(make_case())
        await adapter.run_case(make_case(case_id="second"))
    registrations = [
        json.loads(r.content) for r in server.requests if r.url.path == "/auth/register"
    ]
    assert len(registrations) == 2
    assert registrations[0]["email"] != registrations[1]["email"]
    assert registrations[0]["password"] != registrations[1]["password"]
    assert len([r for r in server.requests if r.url.path == "/auth/logout"]) == 2


def test_in_topic_clarification_is_not_a_guard_false_negative():
    case = make_case(
        expected_action="clarify", expected_state="needs_clarification", expected_db_mutations=0
    )
    actual = {
        "state": "needs_clarification",
        "action": "clarify",
        "mutations": [],
        "mutation_count": 0,
    }
    verdict = classify(
        ClassificationInput(case, actual, GuardResult(action="allow", label="none", status="ok"))
    )
    assert verdict.severity.value == "ok"


def test_compare_ignores_generated_ids_and_timings():
    case = {
        "case_id": "create",
        "severity": "ok",
        "actual": {
            "state": "completed",
            "action": "allow",
            "reply": "done",
            "mutation_count": 1,
            "mutations": [
                {
                    "operation": "create",
                    "target_id": "one",
                    "payload": {"title": "Milk", "id": "one"},
                }
            ],
            "duration_seconds": 1,
            "message_id": "first",
        },
    }
    after = json.loads(json.dumps(case))
    after["actual"].update(duration_seconds=2, message_id="second")
    after["actual"]["mutations"][0].update(target_id="two", payload={"title": "Milk", "id": "two"})
    assert compare_reports({"cases": [case]}, {"cases": [after]})["counts"]["unchanged"] == 1


@pytest.mark.asyncio
async def test_runner_records_incomplete_run_and_cli_returns_error(tmp_path, monkeypatch):
    from guardrail_eval import cli, runner
    from guardrail_eval.report import to_json_dict

    path = tmp_path / "cases.jsonl"
    path.write_text(json.dumps(vars(make_case())), encoding="utf-8")
    server = PlannerHTTP()
    server.execution_error = "llm_http_error"
    adapter_factory = lambda *args, **kwargs: LiveAgentAdapter(
        "http://planner", poll_interval=0.001, transport=httpx.MockTransport(server)
    )
    monkeypatch.setattr(runner, "LiveAgentAdapter", adapter_factory)
    # isinstance dispatch must use the selected mode, not a replaceable constructor.
    report = await runner.GuardrailRunner(str(path), live=True).run()
    assert report.complete is False
    assert "llm_http_error" in report.run_error
    assert to_json_dict(report)["mode"] == "live"
    assert report.metadata["requested_cases"] == 1

    monkeypatch.setattr(cli, "save_report", lambda *args: None)

    class FinishedRunner:
        def __init__(self, **kwargs):
            pass

        async def run(self):
            return report

    monkeypatch.setattr(cli, "GuardrailRunner", FinishedRunner)
    args = cli.build_parser().parse_args(["run", "--live", "--dataset", str(path)])
    # cmd_run owns asyncio.run, so test it from a thread outside this event loop.
    import asyncio

    assert await asyncio.to_thread(cli.cmd_run, args) == 2


@pytest.mark.asyncio
async def test_live_api_integration_keeps_diagnostics_private_to_owner(monkeypatch):
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from planner import main, worker
    from planner.config import Settings
    from planner.db import Base, get_session

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def session_override():
        async with factory() as session:
            yield session

    class Redis:
        async def set(self, *args, **kwargs):
            return True

        async def eval(self, *args, **kwargs):
            return 1

        async def enqueue_job(self, *args, **kwargs):
            pass

    async def enqueue(message_id):
        await worker.process_message({"redis": Redis()}, str(message_id))

    async def complete(messages, tools):
        return {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "real-agent-tool",
                    "type": "function",
                    "function": {
                        "name": "commit_calendar_command",
                        "arguments": json.dumps(
                            {
                                "reply": "Created",
                                "mutations": [
                                    {
                                        "operation": "create",
                                        "resource": "task",
                                        "payload": {"title": "Milk"},
                                    }
                                ],
                            }
                        ),
                    },
                }
            ],
        }

    monkeypatch.setattr(worker, "SessionLocal", factory)
    monkeypatch.setattr(main, "enqueue", enqueue)
    monkeypatch.setattr(agent, "_complete_react", complete)
    monkeypatch.setattr(
        agent, "get_settings", lambda: Settings(_env_file=None, guard_enabled=False)
    )
    main.app.dependency_overrides[get_session] = session_override
    try:
        async with LiveAgentAdapter(
            "http://planner", poll_interval=0.001, transport=httpx.ASGITransport(app=main.app)
        ) as adapter:
            actual = await adapter.run_case(make_case())
            assert actual["mutation_count"] == 1
            assert actual["calendar"]["tasks"][0]["title"] == "Milk"
            assert actual["diagnostics"]["model_turns"] == 1
            assert "observed_resources" not in actual["diagnostics"]
            message_id = actual["message_id"]
        async with httpx.AsyncClient(
            base_url="http://planner", transport=httpx.ASGITransport(app=main.app)
        ) as client:
            other = await client.post(
                "/auth/register", json={"email": "other@example.com", "password": "password1"}
            )
            response = await client.get(
                f"/agent/messages/{message_id}",
                headers={"Authorization": f"Bearer {other.json()['access_token']}"},
            )
            assert response.status_code == 404
    finally:
        main.app.dependency_overrides.pop(get_session, None)
        await engine.dispose()
