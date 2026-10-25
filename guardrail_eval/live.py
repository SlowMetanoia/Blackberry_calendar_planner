"""Run cases against an already running planner, without patching its models."""

from __future__ import annotations

import asyncio
import secrets
import time
from typing import Any, Self
from uuid import uuid4

import httpx

from .models import EvalCase
from .results import infer_action


class LiveEvaluationError(RuntimeError):
    """The environment could not finish a trustworthy evaluation."""


class LiveAgentAdapter:
    def __init__(
        self,
        api_url: str,
        *,
        case_timeout: float = 180,
        poll_interval: float = 0.5,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        url = httpx.URL(api_url)
        if url.scheme not in {"http", "https"} or not url.host or url.userinfo or url.query:
            raise ValueError("api-url must be an http(s) URL without credentials or query")
        if case_timeout <= 0 or poll_interval <= 0:
            raise ValueError("case-timeout and poll-interval must be positive")
        self.api_url = api_url.rstrip("/")
        self.case_timeout = case_timeout
        self.poll_interval = poll_interval
        self._client = httpx.AsyncClient(
            base_url=self.api_url,
            timeout=min(case_timeout, 15),
            transport=transport,
        )
        self._headers: dict[str, str] = {}

    async def __aenter__(self) -> Self:
        try:
            health = await self._request("GET", "/health")
            if health.get("status") != "ok":
                raise LiveEvaluationError("Planner health check failed")
        except BaseException:
            await self._client.aclose()
            raise
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        await self._client.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            response = await self._client.request(method, path, headers=self._headers, **kwargs)
            response.raise_for_status()
            body = response.json() if response.content else {}
            if not isinstance(body, dict):
                raise LiveEvaluationError(f"Invalid object from planner: {method} {path}")
            return body
        except httpx.HTTPStatusError as exc:
            raise LiveEvaluationError(
                f"Planner returned HTTP {exc.response.status_code} for {method} {path}"
            ) from exc
        except httpx.RequestError as exc:
            raise LiveEvaluationError(
                f"Cannot reach planner at {self.api_url} ({type(exc).__name__}). "
                "Check API, Redis and worker. No mock fallback was used."
            ) from exc
        except ValueError as exc:
            raise LiveEvaluationError(f"Invalid JSON from planner: {method} {path}") from exc

    async def _page(self, path: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        offset = 0
        while True:
            page = await self._request("GET", path, params={"limit": 100, "offset": offset})
            batch = page.get("items")
            if not isinstance(batch, list) or not isinstance(page.get("total"), int):
                raise LiveEvaluationError(f"Invalid page from {path}")
            items.extend(batch)
            offset += len(batch)
            if offset >= page["total"]:
                return items
            if not batch:
                raise LiveEvaluationError(f"Incomplete page from {path}")

    async def run_case(self, case: EvalCase) -> dict[str, Any]:
        started = time.monotonic()
        try:
            async with asyncio.timeout(self.case_timeout):
                result = await self._run_case(case)
            result["duration_seconds"] = round(time.monotonic() - started, 3)
            return result
        except TimeoutError as exc:
            raise LiveEvaluationError(
                f"Timeout after {self.case_timeout:g}s in case {case.case_id}; "
                "check worker and model logs. The queued message may still finish."
            ) from exc
        finally:
            if self._headers:
                try:
                    await self._client.post("/auth/logout", headers=self._headers, timeout=5)
                except httpx.HTTPError:
                    pass
                self._headers = {}

    async def _run_case(self, case: EvalCase) -> dict[str, Any]:
        if case.raw.get("conflict_scenario") and not case.raw.get("initial_events"):
            raise LiveEvaluationError(
                f"{case.case_id}: conflict_scenario needs explicit initial_events for live mode"
            )
        token = await self._request(
            "POST",
            "/auth/register",
            json={
                "email": f"planner-eval-{uuid4().hex}@example.com",
                "password": secrets.token_urlsafe(24),
            },
        )
        if not token.get("access_token"):
            raise LiveEvaluationError("Planner registration returned no access token")
        self._headers = {"Authorization": f"Bearer {token['access_token']}"}
        await self._request(
            "PUT",
            "/users/me/timezone",
            json={"timezone": case.raw.get("timezone", "Europe/Moscow")},
        )
        for resource in ("tasks", "events"):
            for payload in case.raw.get(f"initial_{resource}", []):
                await self._request("POST", f"/{resource}", json=payload)
        try:
            response = await self._client.post(
                "/agent/messages",
                headers=self._headers,
                json={"text": case.user_input},
            )
        except httpx.RequestError as exc:
            raise LiveEvaluationError("Cannot submit message to planner") from exc
        if response.status_code == 422 and case.expected_category == "input_validation":
            return {
                "state": "failed",
                "action": "refuse",
                "reply": "",
                "http_status": 422,
                "mutations": [],
                "mutation_count": 0,
                "diagnostics": {},
                "calendar": {
                    "tasks": await self._page("/tasks"),
                    "events": await self._page("/events"),
                },
            }
        if response.status_code != 202:
            raise LiveEvaluationError(f"Message submission returned HTTP {response.status_code}")
        try:
            message_id = response.json()["id"]
        except (ValueError, KeyError, TypeError) as exc:
            raise LiveEvaluationError("Message submission returned no message ID") from exc
        while True:
            message = await self._request("GET", f"/agent/messages/{message_id}")
            if message.get("status") in {"completed", "needs_clarification", "failed"}:
                break
            if message.get("status") not in {"queued", "processing", "transcribing"}:
                raise LiveEvaluationError("Planner returned an unknown message status")
            await asyncio.sleep(self.poll_interval)
        diagnostics = message.get("diagnostics")
        if not isinstance(diagnostics, dict) or not diagnostics:
            raise LiveEvaluationError(
                "Worker diagnostics are missing. Rebuild/restart API and worker with current code."
            )
        if not isinstance(diagnostics.get("llm_model"), str) or not isinstance(
            diagnostics.get("model_turns"), int
        ):
            raise LiveEvaluationError("Invalid worker diagnostics; rebuild API and worker")
        if diagnostics.get("llm_model") == "fake-planner":
            raise LiveEvaluationError("The server uses fake-planner; configure a real LLM")
        if diagnostics.get("execution_error") or message.get("error"):
            raise LiveEvaluationError(
                f"Case {case.case_id}: worker/model failed "
                f"({diagnostics.get('execution_error') or 'worker_error'})"
            )
        decisions = [diagnostics.get("input_guard") or {}, diagnostics.get("blocking_guard") or {}]
        if any(
            d.get("reason") in {"guard_unavailable", "invalid_guard_response"} for d in decisions
        ):
            raise LiveEvaluationError("Guard service is unavailable or returned invalid data")
        if case.requires_remote_guard and not diagnostics.get("guard_enabled"):
            raise LiveEvaluationError(f"{case.case_id} requires an enabled remote guard")
        history = await self._page("/calendar/history")
        operations = [item for item in history if item.get("source_message_id") == message_id]
        mutations = [
            {
                "operation": item["operation"],
                "resource": item["resource"],
                "target_id": item.get("target_id"),
                "payload": item.get("after") or {},
            }
            for item in operations
        ]
        return {
            "state": message["status"],
            "action": infer_action(message["status"], diagnostics),
            "reply": message.get("reply") or "",
            "message_id": message_id,
            "mutations": mutations,
            "mutation_count": len(mutations),
            "diagnostics": diagnostics,
            "history": operations,
            "calendar": {
                "tasks": await self._page("/tasks"),
                "events": await self._page("/events"),
            },
        }
