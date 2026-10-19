"""TTL-cached prompt bundle loaded from a versioned YAML file."""

import asyncio
import logging
import re
import time
from collections.abc import Callable, Mapping
from functools import lru_cache
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .config import get_settings

logger = logging.getLogger(__name__)
_PLACEHOLDER_PATTERN = re.compile(r"\{\{\s*(\w+)\s*\}\}")


class PromptBundleError(RuntimeError):
    """The prompt bundle file is missing or invalid."""


class PromptNotFound(LookupError):
    """The prompt bundle does not contain the requested prompt."""


class PromptRenderError(ValueError):
    """Template parameters are missing or the template kind does not match."""


def _substitute(template: str, values: Mapping[str, str]) -> str:
    def replace(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in values:
            raise PromptRenderError(f"Prompt parameter {key!r} is missing")
        return str(values[key])

    return _PLACEHOLDER_PATTERN.sub(replace, template)


class PromptMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["system", "user", "assistant"]
    content: str


class PromptSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    template: str | list[PromptMessage]
    description: str | None = None
    parameters: list[str] = Field(default_factory=list)
    tags: dict[str, str] = Field(default_factory=dict)
    commit_message: str | None = None


class PromptBundle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int = Field(ge=1)
    prompts: dict[str, PromptSpec] = Field(min_length=1)


class PromptsManager:
    """Serves prompts from a YAML bundle, re-reading it after ttl_seconds."""

    def __init__(
        self,
        path: str | Path,
        ttl_seconds: float = 30.0,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if ttl_seconds < 0:
            raise ValueError("ttl_seconds must be non-negative")
        self.path = Path(path)
        self._ttl_seconds = float(ttl_seconds)
        self._clock = clock
        self._lock = asyncio.Lock()
        self._bundle: PromptBundle | None = None
        self._loaded_at: float | None = None

    async def get(self, name: str) -> PromptSpec:
        bundle = await self.bundle()
        try:
            return bundle.prompts[name]
        except KeyError as exc:
            raise PromptNotFound(name) from exc

    async def render(self, name: str, /, **values: str) -> str:
        spec = await self.get(name)
        if not isinstance(spec.template, str):
            raise PromptRenderError(f"Prompt {name!r} is a chat template; use render_messages")
        return _substitute(spec.template, values)

    async def render_messages(self, name: str, /, **values: str) -> list[dict[str, str]]:
        spec = await self.get(name)
        if isinstance(spec.template, str):
            raise PromptRenderError(f"Prompt {name!r} is a text template; use render")
        return [
            {"role": message.role, "content": _substitute(message.content, values)}
            for message in spec.template
        ]

    async def bundle(self) -> PromptBundle:
        if self._bundle is not None and not self._expired():
            return self._bundle
        async with self._lock:
            if self._bundle is not None and not self._expired():
                return self._bundle
            try:
                loaded = await self._read()
            except Exception as exc:  # keep serving the last good bundle
                if self._bundle is None:
                    raise
                logger.warning(
                    "Prompt bundle reload failed: %s; keeping cached version",
                    type(exc).__name__,
                )
                self._loaded_at = self._clock()
                return self._bundle
            self._store(loaded)
            return loaded

    async def reload(self) -> PromptBundle:
        async with self._lock:
            loaded = await self._read()
            self._store(loaded)
            return loaded

    def _store(self, bundle: PromptBundle) -> None:
        self._bundle = bundle
        self._loaded_at = self._clock()
        logger.info(
            "Prompt bundle loaded version=%d prompts=%d path=%s",
            bundle.version,
            len(bundle.prompts),
            self.path,
        )

    def _expired(self) -> bool:
        if self._loaded_at is None:
            return True
        return self._clock() - self._loaded_at >= self._ttl_seconds

    async def _read(self) -> PromptBundle:
        return await asyncio.to_thread(self._read_sync)

    def _read_sync(self) -> PromptBundle:
        try:
            raw = self.path.read_text(encoding="utf-8")
        except OSError as exc:
            raise PromptBundleError(f"Prompt bundle is unavailable at {self.path}") from exc
        try:
            data = yaml.safe_load(raw)
        except yaml.YAMLError as exc:
            raise PromptBundleError(f"Prompt bundle at {self.path} is not valid YAML") from exc
        try:
            return PromptBundle.model_validate(data)
        except ValidationError as exc:
            raise PromptBundleError(f"Prompt bundle at {self.path} failed validation") from exc


@lru_cache(maxsize=1)
def get_prompts_manager() -> PromptsManager:
    settings = get_settings()
    return PromptsManager(settings.prompts_path, ttl_seconds=settings.prompts_cache_ttl_seconds)
