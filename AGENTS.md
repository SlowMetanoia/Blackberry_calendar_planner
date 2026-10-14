# Repository Guidelines

## Project Structure & Module Organization

`humanplan.md` is the authoritative product and architecture note; do not change it without the user’s approval. The repository contains a Python backend for a voice-controlled planner, with an API first and a React interface later. Keep application code under `src/` (or a named package), tests under `tests/`, and non-code assets under `assets/`. Organize modules around tasks, events, LangGraph orchestration, and integrations rather than one large module.

## Build, Test, and Development Commands

Use the checked-in Python project and Docker Compose commands:

- `.venv/bin/python -m pytest -q` — run the full test suite.
- `.venv/bin/python -m pytest tests/test_security.py -q` — run focused tests.
- `PYTHONPATH=src uvicorn planner.main:app --reload` — run the FastAPI service locally.
- `docker compose --profile release run --rm migrate` — apply Alembic migrations.
- `docker compose up --build` — start API, worker, Redis, and PostgreSQL.

LangGraph is the agent orchestration layer; keep its graph behind the `run_agent` application boundary. Redis/ARQ handles background jobs, while PostgreSQL stores application data.

## Coding Style & Naming Conventions

Use Python 4-space indentation, type hints, and small functions. Prefer `snake_case` for modules, functions, and variables; `PascalCase` for classes; and descriptive names (`Task`, `Event`, `CalendarClient`). Format and lint with tools declared in `pyproject.toml` (for example, Ruff), and keep imports and public interfaces explicit. React code should use the project’s formatter and `PascalCase` component names.

## Testing Guidelines

Follow the project’s stated TDD workflow: write a failing test first, implement the simplest behavior, then refactor. Use pytest; name files `test_*.py`, functions `test_<behavior>`, and fixtures for shared setup. Cover CRUD behavior, ambiguous voice requests, and tool/integration boundaries. Keep external services (speech recognition, calendars, maps, PostgreSQL) behind interfaces and mock them in unit tests.

## Todo Plans

Store implementation plans in `todo/` as self-contained Markdown files. Each plan must include the user request, the relevant repository and conversation context available before the plan was written, implementation steps, acceptance criteria, verification commands, and the expected final report with test results.

Execute plans from `todo/` one at a time. Do not begin another todo plan until the current plan has been implemented and verified. After a plan is fully completed, delete its file from `todo/`. If work is blocked or incomplete, keep the plan in place and record the remaining work in it rather than deleting it. The general `BACKLOG.md` is for deferred ideas and is not an executable todo queue.

## Commit & Pull Request Guidelines

There is no Git history yet, so no existing commit convention can be inferred. Use short, imperative subjects (for example, `Add task CRUD endpoint`) and make commits represent meaningful progress; do not add the agent as an author. Pull requests should explain the behavior changed, link a relevant issue or plan item, list tests run, and include API examples or screenshots when the interface changes.

## Security & Configuration Tips

Keep database URLs, API keys, and model credentials in environment variables or an untracked `.env` file. Never commit secrets, recordings, or personal calendar data. Validate and authorize every agent tool call, and use isolated test databases for PostgreSQL-backed tests.

Agent workflow uses LangGraph behind `run_agent`: strict JSON envelope validation, immediate reads, persisted action plans for mutations, and owner-scoped plan confirmation endpoints under `/agent/plans`. Run `.venv/bin/python -m pytest -q` for the full suite; plan migrations are applied with the release Compose migrate command.

Plan confirmations return `202` and enqueue idempotent ARQ jobs; create-only plans enqueue a 15-second auto-confirm job. Message jobs are serialized per conversation with a Redis lock. Focused checks: `.venv/bin/python -m pytest tests/test_plans.py -q` and `.venv/bin/python -m pytest tests/test_worker.py -q`.

The React/Vite client lives in `web/`; run `npm --prefix web test` and `npm --prefix web run build`. Full API/worker coverage uses the isolated fake LLM/STT environment through `./dev/test-e2e`.
