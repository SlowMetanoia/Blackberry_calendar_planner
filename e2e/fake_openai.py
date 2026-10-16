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
        earlier_user_messages = [
            message["content"].lower() for message in messages[:-1] if message["role"] == "user"
        ]
        if "что у меня на завтра" in lowered:
            time_range = {"from": "2026-10-15T00:00:00+03:00", "to": "2026-10-16T00:00:00+03:00"}
            calls = (
                [("finish_response", {"reply": "Вот ваши задачи и события на завтра"})]
                if observed
                else [
                    ("list_tasks", {"time_range": time_range}),
                    ("list_events", {"time_range": time_range}),
                ]
            )
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
            calls = (
                [("finish_response", {"reply": "Нашёл задачу"})]
                if observed
                else [("search_calendar", {"query": "молоко", "resource": "task"})]
            )
        elif "покажи" in lowered:
            calls = (
                [("finish_response", {"reply": "Вот ваши задачи"})]
                if observed
                else [("list_tasks", {})]
            )
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
