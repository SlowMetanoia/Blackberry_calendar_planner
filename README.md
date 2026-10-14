# Smart Planner

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
Секреты хранятся только в `.env`; файл не должен попадать в Git.

Чтения агента выполняются сразу. Изменения возвращаются как план через `/agent/plans/{plan_id}`;
подтверждение ставит отдельные идемпотентные ARQ-задачи. Планы только с созданием автоматически
подтверждаются через 15 секунд, если пользователь не отменил их.
