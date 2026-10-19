import logging
from pathlib import Path

import pytest

from planner.prompts_manager import (
    PromptBundleError,
    PromptNotFound,
    PromptRenderError,
    PromptsManager,
)

REPO_ROOT = Path(__file__).resolve().parents[1]


class FakeClock:
    def __init__(self, now: float = 0.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


def bundle_text(marker: str, *, version: int = 1) -> str:
    return f"""
version: {version}
prompts:
  agent_system:
    description: ReAct system prompt
    parameters: [local_now, timezone_name]
    tags:
      role: system
    template: |
      You are a planner agent ({marker}).
      Now: {{{{ local_now }}}}
  protocol_error:
    template: |
      Protocol error ({marker})
"""


def write_bundle(path, marker: str, *, version: int = 1) -> None:
    path.write_text(bundle_text(marker, version=version), encoding="utf-8")


async def test_loads_bundle_and_returns_prompt(tmp_path) -> None:
    path = tmp_path / "planner-agent.yaml"
    write_bundle(path, "v1")

    manager = PromptsManager(path, ttl_seconds=30)

    spec = await manager.get("agent_system")
    assert "agent (v1)" in spec.template
    assert "{{ local_now }}" in spec.template
    assert spec.parameters == ["local_now", "timezone_name"]
    assert spec.tags == {"role": "system"}

    minimal = await manager.get("protocol_error")
    assert minimal.parameters == []
    assert minimal.tags == {}

    bundle = await manager.bundle()
    assert bundle.version == 1
    assert set(bundle.prompts) == {"agent_system", "protocol_error"}


async def test_chat_style_template_is_supported(tmp_path) -> None:
    path = tmp_path / "planner-agent.yaml"
    path.write_text(
        """
version: 1
prompts:
  greeting:
    template:
      - role: system
        content: Hello {{ name }}
      - role: user
        content: Question
""",
        encoding="utf-8",
    )

    spec = await PromptsManager(path).get("greeting")

    assert isinstance(spec.template, list)
    assert [message.role for message in spec.template] == ["system", "user"]
    assert spec.template[0].content == "Hello {{ name }}"


async def test_unknown_prompt_raises_prompt_not_found(tmp_path) -> None:
    path = tmp_path / "planner-agent.yaml"
    write_bundle(path, "v1")

    with pytest.raises(PromptNotFound):
        await PromptsManager(path).get("missing")


async def test_bundle_is_cached_until_ttl_expires(tmp_path) -> None:
    clock = FakeClock()
    path = tmp_path / "planner-agent.yaml"
    write_bundle(path, "v1")
    manager = PromptsManager(path, ttl_seconds=30, clock=clock)

    assert "v1" in (await manager.get("agent_system")).template

    write_bundle(path, "v2")

    clock.now = 29.0
    assert "v1" in (await manager.get("agent_system")).template

    clock.now = 30.0
    assert "v2" in (await manager.get("agent_system")).template


async def test_zero_ttl_reloads_on_every_read(tmp_path) -> None:
    clock = FakeClock()
    path = tmp_path / "planner-agent.yaml"
    write_bundle(path, "v1")
    manager = PromptsManager(path, ttl_seconds=0, clock=clock)

    assert "v1" in (await manager.get("agent_system")).template

    write_bundle(path, "v2")
    assert "v2" in (await manager.get("agent_system")).template


async def test_failed_reload_keeps_last_known_good(tmp_path, caplog) -> None:
    clock = FakeClock()
    path = tmp_path / "planner-agent.yaml"
    write_bundle(path, "v1")
    manager = PromptsManager(path, ttl_seconds=30, clock=clock)
    await manager.get("agent_system")

    path.write_text("prompts: [broken", encoding="utf-8")
    clock.now = 30.0

    with caplog.at_level(logging.WARNING, logger="planner.prompts_manager"):
        spec = await manager.get("agent_system")

    assert "v1" in spec.template
    assert "reload failed" in caplog.text


async def test_failed_reload_is_retried_only_after_ttl(tmp_path) -> None:
    clock = FakeClock()
    path = tmp_path / "planner-agent.yaml"
    write_bundle(path, "v1")
    manager = PromptsManager(path, ttl_seconds=30, clock=clock)
    await manager.get("agent_system")

    path.write_text("prompts: [broken", encoding="utf-8")
    clock.now = 30.0
    assert "v1" in (await manager.get("agent_system")).template

    write_bundle(path, "v2")
    clock.now = 59.0
    assert "v1" in (await manager.get("agent_system")).template

    clock.now = 60.0
    assert "v2" in (await manager.get("agent_system")).template


async def test_initial_load_failure_raises_bundle_error(tmp_path) -> None:
    path = tmp_path / "planner-agent.yaml"
    path.write_text("prompts: [broken", encoding="utf-8")

    with pytest.raises(PromptBundleError):
        await PromptsManager(path).get("agent_system")


async def test_missing_file_raises_bundle_error(tmp_path) -> None:
    manager = PromptsManager(tmp_path / "missing.yaml")

    with pytest.raises(PromptBundleError):
        await manager.get("agent_system")


@pytest.mark.parametrize(
    "content",
    [
        "prompts:\n  only_template:\n    template: ok\n",
        "version: 0\nprompts:\n  only_template:\n    template: ok\n",
        "version: 1\nprompts: {}\n",
        "version: 1\nprompts:\n  broken: {}\n",
        "version: 1\nprompts:\n  broken:\n    template: ok\n    unknown_field: 1\n",
    ],
)
async def test_invalid_bundle_is_rejected(tmp_path, content) -> None:
    path = tmp_path / "planner-agent.yaml"
    path.write_text(content, encoding="utf-8")

    with pytest.raises(PromptBundleError):
        await PromptsManager(path).bundle()


async def test_reload_forces_reread_and_raises_on_broken_file(tmp_path) -> None:
    path = tmp_path / "planner-agent.yaml"
    write_bundle(path, "v1")
    manager = PromptsManager(path, ttl_seconds=60, clock=FakeClock())
    await manager.get("agent_system")

    path.write_text("prompts: [broken", encoding="utf-8")

    with pytest.raises(PromptBundleError):
        await manager.reload()
    assert "v1" in (await manager.get("agent_system")).template


def test_negative_ttl_is_rejected(tmp_path) -> None:
    with pytest.raises(ValueError):
        PromptsManager(tmp_path / "planner-agent.yaml", ttl_seconds=-1)


async def test_render_substitutes_parameters(tmp_path) -> None:
    path = tmp_path / "planner-agent.yaml"
    path.write_text(
        """
version: 1
prompts:
  greeting:
    parameters: [name]
    template: |-
      Hello {{ name }}, hi {{name}}!
""",
        encoding="utf-8",
    )
    manager = PromptsManager(path)

    assert await manager.render("greeting", name="Ada", unused="ignored") == "Hello Ada, hi Ada!"


async def test_render_requires_every_parameter(tmp_path) -> None:
    path = tmp_path / "planner-agent.yaml"
    path.write_text(
        """
version: 1
prompts:
  greeting:
    template: Hello {{ name }}
""",
        encoding="utf-8",
    )
    manager = PromptsManager(path)

    with pytest.raises(PromptRenderError):
        await manager.render("greeting")


async def test_render_messages_renders_chat_templates(tmp_path) -> None:
    path = tmp_path / "planner-agent.yaml"
    path.write_text(
        """
version: 1
prompts:
  greeting:
    template:
      - role: system
        content: Hello {{ name }}
      - role: user
        content: Question
""",
        encoding="utf-8",
    )
    manager = PromptsManager(path)

    assert await manager.render_messages("greeting", name="Ada") == [
        {"role": "system", "content": "Hello Ada"},
        {"role": "user", "content": "Question"},
    ]


async def test_render_kinds_are_enforced(tmp_path) -> None:
    path = tmp_path / "planner-agent.yaml"
    path.write_text(
        """
version: 1
prompts:
  text:
    template: Hello
  chat:
    template:
      - role: system
        content: Hello
""",
        encoding="utf-8",
    )
    manager = PromptsManager(path)

    with pytest.raises(PromptRenderError):
        await manager.render("chat")
    with pytest.raises(PromptRenderError):
        await manager.render_messages("text")


async def test_repository_bundle_renders_agent_prompts() -> None:
    manager = PromptsManager(REPO_ROOT / "prompts" / "planner-agent.yaml")

    spec = await manager.get("agent_system")
    assert spec.parameters == ["local_now", "timezone_name"]

    system = await manager.render(
        "agent_system",
        local_now="2026-10-14T19:30:00+03:00",
        timezone_name="Europe/Moscow",
    )
    assert "{{" not in system
    assert "Current local datetime: 2026-10-14T19:30:00+03:00" in system
    assert "User IANA timezone: Europe/Moscow" in system

    referenced = await manager.render(
        "referenced_records", referenced_resources='{"referenced_resources": []}'
    )
    assert "{{" not in referenced
    assert referenced.endswith('{"referenced_resources": []}')

    repair = await manager.render("protocol_error")
    assert "terminal tool call" in repair
