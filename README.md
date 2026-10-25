# Smart Planner

## Safety guard

The API has a Russian-capable, optional safety boundary before the planner
agent. Set `GUARD_ENABLED=true` and point `GUARD_BASE_URL` at a local guard
service. The service receives:

```json
{"model":"auren-research/lunaris-guardv3","text":"...","source":"user_input"}
```

at `POST /classify` and should return:

```json
{
  "action": "allow",
  "label": "none",
  "score": 0.01,
  "reason": "..."
}
```

Use `action: "refuse"` for prompt injection, hate speech, extremist praise,
violence, sexual abuse, or other unsafe content. Use `label: "off_topic"` and
`action: "clarify"` for requests unrelated to calendar tasks and events.

The default configured model is `auren-research/lunaris-guardv3`. It is a
multilingual model with prompt-injection and safety heads; evaluate it on a
Russian test set before production rollout. The backend still performs
deterministic pattern checks and independent owner/schema/tool authorization,
so the guard model is not treated as an authorization mechanism.

The default Docker Compose setup now includes this guard service. The first
startup downloads the model into the `guard_models` volume and can take time.
The API calls it internally at `http://guard:8090/classify`; users continue to
send messages to the existing chat endpoint and do not call the guard endpoint
directly.

Асинхронный backend умного ежедневника. API принимает текстовые и голосовые сообщения,
ставит их в Redis-очередь, а worker выполняет STT/LLM-обработку и сохраняет результат в PostgreSQL.
Агентный pipeline оркестрируется LangGraph; его граф скрыт за внутренним `run_agent`-контрактом.

## Запуск

```bash
cp .env.example .env
docker compose --profile release run --rm migrate
docker compose up --build
```

Веб-чат доступен на `http://localhost:3000`, Swagger UI — на `http://localhost:8000/docs`.
Для MVP порты должны быть доступны только
из доверенной сети или через VPN/firewall.

## Разработка

```bash
python -m pip install -e '.[test]'
python -m pytest
npm --prefix web install
npm --prefix web test
npm --prefix web run build
./dev/test-e2e
```

Настройте `LLM_BASE_URL` и `STT_BASE_URL` как корневые URL OpenAI-compatible API.
Для LM Studio на host используйте `LLM_BASE_URL=http://127.0.0.1:1234`, а в Docker
Compose — `http://host.docker.internal:1234`. API проверяет `/v1/models` при старте и
не запускается, если `LLM_MODEL=qwen/qwen3.8-27b` недоступна. Reasoning для
command interpreter отключается через `LLM_REASONING_EFFORT=none`.
Локальный speech-to-text на GigaAM настраивается по инструкции [GIGAAM.md](GIGAAM.md).
Секреты хранятся только в `.env`; файл не должен попадать в Git.

Чтения агента выполняются сразу. Изменения выполняются сразу одной атомарной командой и
записываются в неизменяемую историю `/calendar/history`. Отмена создаёт компенсирующую
операцию; задачи и события можно восстановить воспроизведением журнала.

## Оценка guardrails с настоящим приложением

После настройки модели и запуска приложения:

```powershell
python -m guardrail_eval run --live --api-url http://localhost:8000 --dataset tests/data/guardrail_live_cases.jsonl --out reports/guardrail_eval/live.json
```

Инструкция для Windows, настройки сервера модели, форматы отчётов и сравнение
«до/после»: [guardrail_eval/README.md](guardrail_eval/README.md).
