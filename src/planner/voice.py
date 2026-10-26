import io
import re
import wave
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

RUSSIAN_WEEKDAYS = (
    "понедельник",
    "вторник",
    "среда",
    "четверг",
    "пятница",
    "суббота",
    "воскресенье",
)
RUSSIAN_MONTHS = (
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
)
RESOURCE_NAMES = {
    "task": ("задача", "задачу"),
    "event": ("событие", "событие"),
    "reminder": ("напоминание", "напоминание"),
}
ACTION_NAMES = {
    ("create", "task"): "Создана",
    ("create", "event"): "Создано",
    ("create", "reminder"): "Создано",
    ("update", "task"): "Изменена",
    ("update", "event"): "Изменено",
    ("update", "reminder"): "Изменено",
    ("delete", "task"): "Удалена",
    ("delete", "event"): "Удалено",
    ("delete", "reminder"): "Удалено",
}
WAKE_WORD = re.compile(r"(^|[^\w])(ivory|айвори|ивори)(?=$|[^\w])", re.IGNORECASE)
STOP_COMMAND = re.compile(
    r"(?:закончи(?:ть)?\s+(?:диалог|разговор)|выключи(?:ть)?\s+(?:hands[ -]?free|хендс[ -]?фри))",
    re.IGNORECASE,
)


class HandsFreeProtocolError(ValueError):
    pass


def _parse_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return None
    return None


def _schedule_text(resource: str, data: dict[str, Any], timezone: str) -> str:
    field_name = {"task": "deadline", "event": "starts_at", "reminder": "remind_at"}.get(resource)
    value = _parse_datetime(data.get(field_name)) if field_name else None
    if value is None:
        return "без срока" if resource == "task" else "время не указано"
    if value.tzinfo is None:
        value = value.replace(tzinfo=ZoneInfo("UTC"))
    local = value.astimezone(ZoneInfo(timezone))
    return (
        f"{RUSSIAN_WEEKDAYS[local.weekday()]}, {local.day} "
        f"{RUSSIAN_MONTHS[local.month - 1]} {local.year} года, {local:%H:%M}"
    )


def format_speech_text(
    *, operations: list[dict[str, Any]], display_items: list[dict[str, Any]], timezone: str
) -> str | None:
    phrases: list[str] = []
    for operation in operations:
        action = operation.get("operation")
        resource = operation.get("resource")
        if action not in {"create", "update", "delete"} or resource not in RESOURCE_NAMES:
            continue
        data = operation.get("before") if action == "delete" else operation.get("after")
        if not isinstance(data, dict):
            data = {}
        title = str(data.get("title") or "Без названия").strip()
        phrases.append(
            f"{ACTION_NAMES[(action, resource)]} {RESOURCE_NAMES[resource][0]} "
            f"«{title}»: {_schedule_text(resource, data, timezone)}."
        )
    for item in display_items:
        resource = item.get("resource")
        data = item.get("data")
        if resource not in RESOURCE_NAMES or not isinstance(data, dict):
            continue
        title = str(data.get("title") or "Без названия").strip()
        label = RESOURCE_NAMES[resource][0].capitalize()
        phrases.append(f"{label} «{title}»: {_schedule_text(resource, data, timezone)}.")
    return " ".join(phrases) or None


def speech_text_for_payload(payload: dict[str, Any], timezone: str) -> str | None:
    structured = format_speech_text(
        operations=payload.get("operations", []),
        display_items=payload.get("display_items", payload.get("reads", [])),
        timezone=timezone,
    )
    notices = " ".join(item["text"] for item in payload.get("collision_notices", []))
    if structured:
        return " ".join(part for part in (structured, notices) if part)
    fallback = payload.get("speech_reply") or payload.get("reply")
    if not isinstance(fallback, str):
        return None
    normalized = " ".join(fallback.split()).strip()
    return " ".join(part for part in (normalized[:1000], notices) if part) or None


def split_speech_text(text: str, *, max_chars: int = 200) -> list[str]:
    normalized = " ".join(text.split()).strip()
    if not normalized:
        return []
    sentences = re.split(r"(?<=[.!?…])\s+", normalized)
    result: list[str] = []
    for sentence in sentences:
        remaining = sentence
        while len(remaining) > max_chars:
            boundary = remaining.rfind(" ", 0, max_chars + 1)
            if boundary <= 0:
                boundary = max_chars
            result.append(remaining[:boundary].strip())
            remaining = remaining[boundary:].strip()
        if remaining:
            result.append(remaining)
    return result


def pcm16_wave_bytes(pcm: bytes, *, sample_rate: int = 16_000) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(sample_rate)
        target.writeframes(pcm)
    return output.getvalue()


@dataclass
class VoiceConversation:
    active: bool = False
    turn_in_progress: bool = False
    max_pcm_bytes: int = 3_200_000
    max_duration_seconds: int = 60
    sample_rate: int = 16_000
    pcm: bytearray = field(default_factory=bytearray)

    def activate(self) -> None:
        self.active = True

    def accept_transcript(self, transcript: str) -> str | None:
        text = " ".join(transcript.split()).strip()
        wake = WAKE_WORD.search(text)
        if STOP_COMMAND.search(text) and (self.active or wake):
            self.active = False
            return None
        if not self.active:
            if wake is None:
                return None
            self.active = True
            return ""
        return text

    def start_turn(self) -> None:
        if self.turn_in_progress:
            raise HandsFreeProtocolError("a voice turn is already in progress")
        self.turn_in_progress = True

    def finish_turn(self) -> None:
        self.turn_in_progress = False

    def begin_utterance(self, *, sample_rate: int) -> None:
        if sample_rate != 16_000:
            raise HandsFreeProtocolError("PCM sample rate must be 16000 Hz")
        self.sample_rate = sample_rate
        self.pcm.clear()

    def add_pcm(self, data: bytes) -> None:
        duration_limit = self.sample_rate * 2 * self.max_duration_seconds
        if len(self.pcm) + len(data) > min(self.max_pcm_bytes, duration_limit):
            raise HandsFreeProtocolError("PCM utterance is too large")
        self.pcm.extend(data)

    def finish_utterance(self) -> bytes:
        if not self.pcm:
            raise HandsFreeProtocolError("PCM utterance is empty")
        value = bytes(self.pcm)
        self.pcm.clear()
        return value
