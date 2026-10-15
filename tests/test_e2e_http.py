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
        if body["status"] in {"completed", "needs_clarification", "failed"}:
            return body
        time.sleep(0.2)
    raise AssertionError("message did not complete")


def register(client, email):
    response = client.post("/auth/register", json={"email": email, "password": "password1"})
    response.raise_for_status()
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def login(client, email):
    response = client.post("/auth/login", json={"email": email, "password": "password1"})
    response.raise_for_status()
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_text_voice_history_undo_and_owner_isolation():
    with httpx.Client(base_url=BASE_URL, timeout=10) as client:
        owner = register(client, "owner-e2e@example.com")
        other = register(client, "other-e2e@example.com")
        second_owner_session = login(client, "owner-e2e@example.com")

        assert client.post("/auth/logout", headers=owner).status_code == 204
        assert client.get("/tasks", headers=owner).status_code == 401
        assert client.get("/tasks", headers=second_owner_session).status_code == 200
        owner = second_owner_session

        timezone = client.put(
            "/users/me/timezone", headers=owner, json={"timezone": "Europe/Moscow"}
        )
        assert timezone.status_code == 200
        assert timezone.json() == {"timezone": "Europe/Moscow"}
        preferences = client.get("/users/me/preferences", headers=owner)
        assert preferences.status_code == 200
        assert preferences.json() == {"timezone": "Europe/Moscow", "upcoming_days": 7}
        preferences = client.patch(
            "/users/me/preferences", headers=owner, json={"upcoming_days": 14}
        )
        assert preferences.status_code == 200
        assert preferences.json() == {"timezone": "Europe/Moscow", "upcoming_days": 14}
        assert (
            client.put(
                "/users/me/timezone", headers=owner, json={"timezone": "Not/AZone"}
            ).status_code
            == 422
        )
        submitted = client.post(
            "/agent/messages", headers=owner, json={"text": "создай задачу Купить молоко"}
        ).json()
        message = wait_message(client, owner, submitted["id"])
        assert message["input_text"] == "создай задачу Купить молоко"
        assert message["status"] == "completed", message.get("error")
        assert message["operations"][0]["operation"] == "create"
        tasks = client.get("/tasks?limit=10&offset=0", headers=owner).json()
        assert tasks["total"] == 1
        assert tasks["items"][0]["title"] == "Купить молоко"
        undated_tasks = client.get(
            "/tasks?status=open&deadline_presence=undated", headers=owner
        ).json()
        assert undated_tasks["total"] == 1
        task_id = tasks["items"][0]["id"]
        patched = client.patch(
            f"/tasks/{task_id}", headers=owner, json={"description": "Изменено частично"}
        ).json()
        assert patched["title"] == "Купить молоко"
        assert patched["description"] == "Изменено частично"
        invalid_page = client.get("/tasks?limit=101", headers=owner)
        assert invalid_page.status_code == 422
        assert invalid_page.json()["code"] == "validation_error"

        audio = client.post(
            "/agent/messages/audio",
            headers=owner,
            files={"audio": ("message.webm", b"fake-audio", "audio/webm")},
        ).json()
        voice = wait_message(client, owner, audio["id"])
        assert voice["input_text"] == "создай задачу Голосовая задача"

        read = client.post(
            "/agent/messages",
            headers=owner,
            json={"text": "покажи задачи", "conversation_id": message["conversation_id"]},
        ).json()
        read_message = wait_message(client, owner, read["id"])
        assert read_message["operations"] == []
        assert {item["data"]["title"] for item in read_message["reads"]} == {
            "Купить молоко",
            "Голосовая задача",
        }

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
        assert contextual["status"] == "completed"
        assert contextual["operations"][0]["resource"] == "event"
        assert contextual["operations"][0]["after"]["title"] == "Встреча по поводу релиза"

        tomorrow = client.post(
            "/agent/messages",
            headers=owner,
            json={"text": "Что у меня на завтра?", "conversation_id": message["conversation_id"]},
        ).json()
        tomorrow_message = wait_message(client, owner, tomorrow["id"])
        assert [item["resource"] for item in tomorrow_message["reads"]] == ["event"]
        assert tomorrow_message["reads"][0]["data"]["title"] == "Встреча по поводу релиза"
        assert tomorrow_message["reads"][0]["data"]["starts_at"].startswith("2026-10-15")

        history = client.get("/calendar/history?limit=100&offset=0", headers=owner).json()
        assert history["total"] >= 4
        assert history["items"][0]["sequence"] > history["items"][-1]["sequence"]
        assert client.get("/calendar/history", headers=other).json()["total"] == 0
        operation_id = history["items"][0]["id"]
        assert (
            client.post(f"/calendar/history/{operation_id}/undo", headers=other).status_code == 404
        )
        undone = client.post(f"/calendar/history/{operation_id}/undo", headers=owner)
        assert undone.status_code == 201
        assert undone.json()["origin"] == "undo"

        conversations = client.get("/agent/conversations?limit=100&offset=0", headers=owner).json()
        assert conversations["total"] >= 2
        assert any(
            item["preview"] == "создай задачу Купить молоко" for item in conversations["items"]
        )
        assert (
            client.get("/agent/conversations?limit=100&offset=0", headers=other).json()["total"]
            == 0
        )
