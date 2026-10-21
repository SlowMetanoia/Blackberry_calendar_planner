import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def _json(self, body, status=200):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.endswith("/models"):
            self._json(
                {
                    "object": "list",
                    "data": [
                        {"id": "fake-planner", "object": "model"},
                        {"id": "fake-embedding", "object": "model"},
                    ],
                }
            )
            return
        self._json({"status": "ok"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        if self.path.endswith("/audio/transcriptions"):
            self._json({"text": "создай задачу Голосовая задача"})
            return
        request = json.loads(raw or b"{}")
        if self.path.endswith("/embeddings"):
            inputs = request.get("input", [])
            if isinstance(inputs, str):
                inputs = [inputs]
            self._json(
                {
                    "object": "list",
                    "model": "fake-embedding",
                    "data": [
                        {
                            "object": "embedding",
                            "index": index,
                            "embedding": [1.0, *([0.0] * 767)],
                        }
                        for index, _text in enumerate(inputs)
                    ],
                }
            )
            return
        messages = request.get("messages", [])
        text = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
        lowered = text.lower()
        observed = bool(messages and messages[-1].get("role") == "tool")
        last_tool = messages[-1].get("name") if observed else None
        observed_references = []
        seen_references = set()
        for message in messages:
            if message.get("role") != "tool" or message.get("name") == "show_calendar_items":
                continue
            try:
                tool_payload = json.loads(message.get("content") or "{}")
            except json.JSONDecodeError:
                continue
            for item in tool_payload.get("data", []):
                key = (item.get("resource"), item.get("id"))
                if (
                    key[0] in {"task", "event", "reminder"}
                    and key[1]
                    and key not in seen_references
                ):
                    observed_references.append({"resource": key[0], "target_id": key[1]})
                    seen_references.add(key)
        earlier_user_messages = [
            message["content"].lower() for message in messages[:-1] if message["role"] == "user"
        ]
        if "создай связанное напоминание" in lowered:
            if last_tool == "list_events":
                rows = json.loads(messages[-1]["content"]).get("data", [])
                calls = [
                    (
                        "commit_calendar_command",
                        {
                            "reply": "Напоминание добавлено",
                            "mutations": [
                                {
                                    "operation": "create",
                                    "resource": "reminder",
                                    "payload": {
                                        "title": "За час до урока",
                                        "linked_resource": "event",
                                        "linked_id": rows[0]["id"],
                                        "relative_offset_minutes": -60,
                                    },
                                }
                            ],
                        },
                    )
                ]
            else:
                calls = [("list_events", {})]
        elif "создай напоминание" in lowered:
            calls = [
                (
                    "commit_calendar_command",
                    {
                        "reply": "Напоминание добавлено",
                        "mutations": [
                            {
                                "operation": "create",
                                "resource": "reminder",
                                "payload": {
                                    "title": "Проверить уведомления",
                                    "remind_at": "2000-01-01T00:00:00Z",
                                },
                            }
                        ],
                    },
                )
            ]
        elif "найди напоминание" in lowered:
            if last_tool == "show_calendar_items":
                calls = [("finish_response", {"reply": "Вот напоминания"})]
            elif observed and observed_references:
                calls = [("show_calendar_items", {"items": observed_references})]
            elif observed:
                calls = [("finish_response", {"reply": "Ничего не найдено"})]
            else:
                calls = [("search_calendar", {"query": "уведомления", "resource": "reminder"})]
        elif "что у меня на завтра" in lowered:
            time_range = {"from": "2026-10-15T00:00:00+03:00", "to": "2026-10-16T00:00:00+03:00"}
            if last_tool == "show_calendar_items":
                calls = [("finish_response", {"reply": "Вот ваши задачи и события на завтра"})]
            elif observed and observed_references:
                calls = [("show_calendar_items", {"items": observed_references})]
            elif observed:
                calls = [("finish_response", {"reply": "На завтра ничего не найдено"})]
            else:
                calls = [
                    ("list_tasks", {"time_range": time_range}),
                    ("list_events", {"time_range": time_range}),
                ]
        elif "по поводу релиза" in lowered and any(
            "добавь встречу" in item for item in earlier_user_messages
        ):
            calls = [
                (
                    "commit_calendar_command",
                    {
                        "reply": "Подготовил встречу по поводу релиза",
                        "mutations": [
                            {
                                "operation": "create",
                                "resource": "event",
                                "payload": {
                                    "title": "Встреча по поводу релиза",
                                    "starts_at": "2026-10-15T11:00:00+03:00",
                                },
                            }
                        ],
                    },
                )
            ]
        elif "добавь встречу" in lowered:
            calls = [("request_clarification", {"question": "Уточните повод встречи"})]
        elif "найди молоко" in lowered:
            if last_tool == "show_calendar_items":
                calls = [("finish_response", {"reply": "Нашёл задачу"})]
            elif observed and observed_references:
                calls = [("show_calendar_items", {"items": observed_references})]
            elif observed:
                calls = [("finish_response", {"reply": "Задача не найдена"})]
            else:
                calls = [("search_calendar", {"query": "молоко", "resource": "task"})]
        elif "покажи" in lowered:
            if last_tool == "show_calendar_items":
                calls = [("finish_response", {"reply": "Вот ваши задачи"})]
            elif observed and observed_references:
                calls = [("show_calendar_items", {"items": observed_references})]
            elif observed:
                calls = [("finish_response", {"reply": "Задач нет"})]
            else:
                calls = [("list_tasks", {})]
        elif "непонятно" in lowered:
            calls = [("request_clarification", {"question": "Уточните, пожалуйста"})]
        else:
            title = text.split("задачу", 1)[-1].strip() or "Новая задача"
            calls = [
                (
                    "commit_calendar_command",
                    {
                        "reply": "Подготовил план",
                        "mutations": [
                            {
                                "operation": "create",
                                "resource": "task",
                                "target_id": None,
                                "payload": {"title": title},
                            }
                        ],
                    },
                )
            ]
        tool_calls = [
            {
                "id": f"fake-{index}",
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(arguments, ensure_ascii=False)},
            }
            for index, (name, arguments) in enumerate(calls, start=1)
        ]
        self._json(
            {
                "choices": [
                    {
                        "finish_reason": "tool_calls",
                        "message": {"role": "assistant", "content": None, "tool_calls": tool_calls},
                    }
                ]
            }
        )

    def log_message(self, *_args):
        return


ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
