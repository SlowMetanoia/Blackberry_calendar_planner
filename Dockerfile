FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml .
RUN mkdir -p src/planner && touch src/planner/__init__.py
RUN pip install --no-cache-dir .
RUN rm -rf src
COPY src ./src
COPY alembic.ini .
COPY migrations ./migrations
ENV PYTHONPATH=/app/src
