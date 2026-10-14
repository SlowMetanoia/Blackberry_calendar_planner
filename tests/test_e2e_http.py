import os
import time

import httpx
import pytest

BASE_URL = os.getenv("E2E_BASE_URL")
pytestmark = pytest.mark.skipif(not BASE_URL, reason="requires Compose e2e environment")


def wait_message(client, token, message_id):
    for _ in range(60):
        response = client.get(f"/agent/messages/{message_id}", headers=token)
        response.raise_for_status()
        body = response.json()
        if body["status"] in {"completed", "needs_confirmation", "needs_clarification", "failed"}:
            return body
        time.sleep(.2)
    raise AssertionError("message did not complete")


def wait_plan(client, token, plan_id):
    for _ in range(60):
        body = client.get(f"/agent/plans/{plan_id}", headers=token).json()
        if body["status"] in {"completed", "failed", "cancelled"}:
            return body
        time.sleep(.2)
    raise AssertionError("plan did not complete")


def register(client, email):
    response = client.post("/auth/register", json={"email": email, "password": "password1"})
    response.raise_for_status()
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_text_voice_plan_and_owner_isolation():
    with httpx.Client(base_url=BASE_URL, timeout=10) as client:
        owner = register(client, "owner-e2e@example.com")
        other = register(client, "other-e2e@example.com")

        timezone = client.put(
            "/users/me/timezone", headers=owner, json={"timezone": "Europe/Moscow"}
        )
        assert timezone.status_code == 200
        assert timezone.json() == {"timezone": "Europe/Moscow"}
        assert client.put(
            "/users/me/timezone", headers=owner, json={"timezone": "Not/AZone"}
        ).status_code == 422
        submitted = client.post("/agent/messages", headers=owner, json={"text": "создай задачу Купить молоко"}).json()
        message = wait_message(client, owner, submitted["id"])
        assert message["input_text"] == "создай задачу Купить молоко"
        assert message["plan_id"]
        forbidden = client.get(f"/agent/plans/{message['plan_id']}", headers=other)
        assert forbidden.status_code == 404
        assert forbidden.headers["content-type"].startswith("application/problem+json")
        assert forbidden.json()["code"] == "http_404"
        confirmed = client.post(f"/agent/plans/{message['plan_id']}/confirm", headers=owner)
        assert confirmed.status_code == 202
        assert wait_plan(client, owner, message["plan_id"])["status"] == "completed"
        tasks = client.get("/tasks?limit=10&offset=0", headers=owner).json()
        assert tasks["total"] == 1
        assert tasks["items"][0]["title"] == "Купить молоко"
        task_id = tasks["items"][0]["id"]
        patched = client.patch(f"/tasks/{task_id}", headers=owner,
                               json={"description": "Изменено частично"}).json()
        assert patched["title"] == "Купить молоко"
        assert patched["description"] == "Изменено частично"
        invalid_page = client.get("/tasks?limit=101", headers=owner)
        assert invalid_page.status_code == 422
        assert invalid_page.json()["code"] == "validation_error"

        audio = client.post("/agent/messages/audio", headers=owner,
                            files={"audio": ("message.webm", b"fake-audio", "audio/webm")}).json()
        voice = wait_message(client, owner, audio["id"])
        assert voice["input_text"] == "создай задачу Голосовая задача"

        read = client.post("/agent/messages", headers=owner,
                           json={"text": "покажи задачи", "conversation_id": message["conversation_id"]}).json()
        read_message = wait_message(client, owner, read["id"])
        assert read_message["plan_id"] is None
        assert read_message["reads"][0]["data"]["title"] == "Купить молоко"

        first_turn = client.post(
            "/agent/messages",
            headers=owner,
            json={
                "text": "Добавь встречу на завтра на 11 утра",
                "conversation_id": message["conversation_id"],
            },
        ).json()
        clarification = wait_message(client, owner, first_turn["id"])
        assert clarification["status"] == "needs_clarification"

        follow_up = client.post(
            "/agent/messages",
            headers=owner,
            json={"text": "По поводу релиза", "conversation_id": message["conversation_id"]},
        ).json()
        contextual = wait_message(client, owner, follow_up["id"])
        assert contextual["status"] == "needs_confirmation"
        contextual_plan = client.get(
            f"/agent/plans/{contextual['plan_id']}", headers=owner
        ).json()
        assert contextual_plan["actions"][0]["resource"] == "event"
        assert contextual_plan["actions"][0]["payload"]["title"] == "Встреча по поводу релиза"
