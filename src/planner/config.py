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
    guard_enabled: bool = False
    guard_base_url: str | None = None
    guard_api_key: str | None = None
    guard_model: str = "auren-research/lunaris-guardv3"
    guard_request_timeout_seconds: float = Field(default=10, gt=0)
    agent_max_model_turns: int = Field(default=6, ge=1, le=20)
    agent_max_tool_calls: int = Field(default=12, ge=1, le=100)
    agent_max_observation_items: int = Field(default=100, ge=1, le=500)
    prompts_path: str = "prompts/planner-agent.yaml"
    prompts_cache_ttl_seconds: float = Field(default=30.0, ge=0)
    embedding_base_url: str | None = None
    embedding_api_key: str | None = None
    embedding_model: str = "ggml-org/embeddinggemma-300M-GGUF"
    embedding_dimensions: int = Field(default=768, ge=1)
    embedding_request_timeout_seconds: float = Field(default=120, gt=0)
    embedding_index_wait_seconds: float = Field(default=60, gt=0)
    embedding_batch_size: int = Field(default=32, ge=1, le=256)
    search_fuzzy_threshold: float = Field(default=0.5, ge=0, le=1)
    search_semantic_threshold: float = Field(default=0.34, ge=-1, le=1)
    stt_base_url: str | None = None
    stt_api_key: str | None = None
    stt_model: str = "gigaam-v3-e2e-rnnt"
    audio_max_upload_bytes: int = Field(default=25 * 1024 * 1024, ge=1)
    voice_ticket_ttl_seconds: int = Field(default=60, ge=10, le=300)
    voice_max_pcm_bytes: int = Field(default=3_200_000, ge=32_000)
    voice_max_duration_seconds: int = Field(default=60, ge=1, le=300)
    voice_terminal_wait_seconds: float = Field(default=180, gt=0)
    tts_base_url: str | None = None
    tts_api_key: str | None = None
    tts_model: str = "v5_6_ru"
    tts_request_timeout_seconds: float = Field(default=60, gt=0)
    web_push_vapid_public_key: str | None = None
    web_push_vapid_private_key: str | None = None
    web_push_vapid_subject: str | None = None

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
