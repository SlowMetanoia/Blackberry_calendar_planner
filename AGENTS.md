# Repository Guidelines

## Project Structure & Module Organization

`humanplan.md` is the authoritative product and architecture note; do not change it without the user’s approval. The repository contains a Python backend for a voice-controlled planner, with an API first and a React interface later. Keep application code under `src/` (or a named package), tests under `tests/`, and non-code assets under `assets/`. Organize modules around tasks, events, LangGraph orchestration, and integrations rather than one large module.

## Build, Test, and Development Commands

Use the checked-in Python project and Docker Compose commands:

- `.venv/bin/python -m pytest -q` — run the full test suite.
- `.venv/bin/python -m pytest tests/test_security.py -q` — run focused tests.
- `.venv/bin/python -m ruff check .` — lint Python code.
- `.venv/bin/python -m ruff format --check .` — verify Python formatting.
- `PYTHONPATH=src uvicorn planner.main:app --reload` — run the FastAPI service locally.
- `docker compose --profile release run --rm migrate` — apply Alembic migrations.
- `docker compose up --build` — start API, worker, Redis, and PostgreSQL.

LangGraph is the agent orchestration layer; keep its graph behind the `run_agent` application boundary. Redis/ARQ handles background jobs, while PostgreSQL stores application data.

## Container Freshness

Every major implementation stage must end by rebuilding and restarting the affected Docker Compose services. Treat architectural changes, new execution paths, schema or dependency changes, and completed todo-plan milestones as major stages. Use `docker compose up --build -d` (or rebuild/restart only the affected services), run migrations first when required, and perform a focused smoke check against the running containers. Do not consider the stage complete until you have verified that the live API and worker are executing the newly built code rather than a stale image. If containers cannot be restarted, report that explicitly as unfinished work.

## Coding Style & Naming Conventions

Use Python 4-space indentation, type hints, and small functions. Prefer `snake_case` for modules, functions, and variables; `PascalCase` for classes; and descriptive names (`Task`, `Event`, `CalendarClient`). Format and lint with tools declared in `pyproject.toml` (for example, Ruff), and keep imports and public interfaces explicit. React code should use the project’s formatter and `PascalCase` component names.

## Testing Guidelines

Follow the project’s stated TDD workflow: write a failing test first, implement the simplest behavior, then refactor. Use pytest; name files `test_*.py`, functions `test_<behavior>`, and fixtures for shared setup. Cover CRUD behavior, ambiguous voice requests, and tool/integration boundaries. Keep external services (speech recognition, calendars, maps, PostgreSQL) behind interfaces and mock them in unit tests.

## Todo Plans

The `todo/` directory may contain implementation plans waiting to be executed. When asked to work on one of them, read the plan into context, carry it out, and delete its file after it has been fully completed. The general `BACKLOG.md` is for deferred ideas and is not an executable todo queue.

## Commit & Pull Request Guidelines

There is no Git history yet, so no existing commit convention can be inferred. Use short, imperative subjects (for example, `Add task CRUD endpoint`) and make commits represent meaningful progress; do not add the agent as an author. Pull requests should explain the behavior changed, link a relevant issue or plan item, list tests run, and include API examples or screenshots when the interface changes.

## Security & Configuration Tips

Keep database URLs, API keys, and model credentials in environment variables or an untracked `.env` file. Never commit secrets, recordings, or personal calendar data. Validate and authorize every agent tool call, and use isolated test databases for PostgreSQL-backed tests.

Agent workflow uses a bounded LangGraph ReAct loop behind `run_agent`: owner-scoped read tools execute immediately and return structured observations to the model. The only mutating terminal tool is `commit_calendar_command`; it validates and executes the final C/U/D batch atomically. Every mutation appends an immutable, owner-scoped `CalendarOperation`; task and event tables are replayable projections. History is available under `/calendar/history`, and undo appends a compensating operation. Message jobs remain serialized per conversation with a Redis lock. Run `.venv/bin/python -m pytest -q` for the full suite; focused checks: `.venv/bin/python -m pytest tests/test_react_agent.py tests/test_calendar_history.py -q` and `.venv/bin/python -m pytest tests/test_worker.py -q`.

Approximate calendar references use the owner-scoped `search_calendar` ReAct read tool. It combines
exact, substring, PostgreSQL trigram, and EmbeddingGemma semantic signals without collapsing them
into one score. Search results are threshold-selected and cursor-paginated. CUD invalidates a
per-user search generation without waiting for embeddings; the dedicated `indexer` ARQ service
rebuilds that user's vectors, and search waits for the required generation. Focused checks:
`.venv/bin/python -m pytest tests/test_calendar_search.py tests/test_search_worker.py tests/test_embeddings.py -q`.

Read-tool results are private ReAct observations and must not be rendered automatically. The model
uses `show_calendar_items` in a separate step to select already observed owner-scoped records for
the user. Agent message responses expose those records as `display_items`; persisted
`observed_resources` remain internal and only support later conversation context. Legacy saved
`reads` are accepted only as a backward-compatible source for deduplicated display items.

The React/Vite client lives in `web/`; run `npm --prefix web test` and `npm --prefix web run build`. Full API/worker coverage uses the isolated fake LLM/STT environment through `./dev/test-e2e`.

Event creation and schedule changes return an owner-scoped `collision_report` alongside the saved
record. Overlaps are facts, not blockers: unknown duration is a point, intervals are half-open,
and recurring series are checked for one year. REST editors show the warning directly. After an
agent commit with overlaps, a response-only model step selects `collision_notices`; raw reports
remain private and selected notices are rendered and spoken. Mutations are committed before this
step and cannot be repeated by it. Run `pytest tests/test_collisions.py -q` for focused coverage.
