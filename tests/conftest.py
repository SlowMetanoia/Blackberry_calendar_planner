import pytest

from planner.config import get_settings


@pytest.fixture(autouse=True)
def isolate_optional_guard_from_local_env(monkeypatch):
    """Unit tests must not depend on a guard container configured in a developer .env."""
    monkeypatch.setenv("GUARD_ENABLED", "false")
    monkeypatch.delenv("GUARD_BASE_URL", raising=False)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
