from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://planner:planner@postgres:5432/planner"
    redis_url: str = "redis://redis:6379/0"
    auth_session_ttl_days: int = Field(default=7, ge=1)
    auth_session_renew_interval_hours: int = Field(default=24, ge=1)
    llm_base_url: str | None = None
    llm_api_key: str | None = None
    llm_model: str = "planner-model"
    llm_required: bool = True
    llm_reasoning_effort: Literal["none", "minimal", "low", "medium", "high", "xhigh"] = "none"
    llm_startup_timeout_seconds: float = Field(default=5, gt=0)
    llm_request_timeout_seconds: float = Field(default=120, gt=0)
    llm_max_tokens: int = Field(default=2048, ge=1)
    stt_base_url: str | None = None
    stt_api_key: str | None = None
    stt_model: str = "gigaam-v3-e2e-rnnt"
    audio_max_upload_bytes: int = Field(default=25 * 1024 * 1024, ge=1)

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
