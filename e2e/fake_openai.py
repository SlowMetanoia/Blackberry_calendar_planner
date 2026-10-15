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
            self._json({"object": "list", "data": [{"id": "fake-planner", "object": "model"}]})
            return
        self._json({"status": "ok"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        if self.path.endswith("/audio/transcriptions"):
            self._json({"text": "создай задачу Голосовая задача"})
            return
        request = json.loads(raw or b"{}")
        text = next(
            (m["content"] for m in reversed(request.get("messages", [])) if m["role"] == "user"), ""
        )
        lowered = text.lower()
        earlier_user_messages = [
            message["content"].lower()
            for message in request.get("messages", [])[:-1]
            if message["role"] == "user"
        ]
        if "что у меня на завтра" in lowered:
            time_range = {"from": "2026-10-15T00:00:00+03:00", "to": "2026-10-16T00:00:00+03:00"}
            envelope = {
                "reply": "Вот ваши задачи и события на завтра",
                "reads": [
                    {"operation": "list", "resource": "task", "time_range": time_range},
                    {"operation": "list", "resource": "event", "time_range": time_range},
                ],
                "mutations": [],
                "clarification": None,
            }
        elif "по поводу релиза" in lowered and any(
            "добавь встречу" in item for item in earlier_user_messages
        ):
            envelope = {
                "reply": "Подготовил встречу по поводу релиза",
                "reads": [],
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
                "clarification": None,
            }
        elif "добавь встречу" in lowered:
            envelope = {
                "reply": "Уточните повод встречи",
                "reads": [],
                "mutations": [],
                "clarification": "Уточните повод встречи",
            }
        elif "покажи" in lowered:
            envelope = {
                "reply": "Вот ваши задачи",
                "reads": [{"operation": "list", "resource": "task"}],
                "mutations": [],
                "clarification": None,
            }
        elif "непонятно" in lowered:
            envelope = {
                "reply": "Уточните, пожалуйста",
                "reads": [],
                "mutations": [],
                "clarification": "Уточните, пожалуйста",
            }
        else:
            title = text.split("задачу", 1)[-1].strip() or "Новая задача"
            envelope = {
                "reply": "Подготовил план",
                "reads": [],
                "mutations": [
                    {
                        "operation": "create",
                        "resource": "task",
                        "target_id": None,
                        "payload": {"title": title},
                    }
                ],
                "clarification": None,
            }
        self._json(
            {"choices": [{"message": {"content": json.dumps(envelope, ensure_ascii=False)}}]}
        )

    def log_message(self, *_args):
        return


ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
