from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://planner:planner@postgres:5432/planner"
    redis_url: str = "redis://redis:6379/0"
    jwt_secret: str = "change-me-in-production-use-a-long-random-secret"
    jwt_expire_minutes: int = 60
    llm_base_url: str | None = None
    llm_api_key: str | None = None
    llm_model: str = "planner-model"
    llm_required: bool = True
    llm_reasoning_effort: Literal["none", "minimal", "low", "medium", "high", "xhigh"] = "none"
    llm_startup_timeout_seconds: float = 5
    llm_request_timeout_seconds: float = 120
    llm_max_tokens: int = 2048
    stt_base_url: str | None = None
    stt_api_key: str | None = None
    stt_model: str = "gigaam-v3-e2e-rnnt"
    create_auto_confirm_seconds: float = 15

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
