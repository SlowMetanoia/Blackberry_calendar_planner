from __future__ import annotations

import os
from functools import lru_cache
from typing import Any

import torch
from fastapi import FastAPI
from pydantic import BaseModel, Field
from transformers import AutoModelForSequenceClassification, AutoTokenizer

MODEL_NAME = os.getenv("GUARD_MODEL", "auren-research/lunaris-guardv3")
MAX_LENGTH = int(os.getenv("GUARD_MAX_LENGTH", "2048"))
INJECTION_THRESHOLD = float(os.getenv("GUARD_INJECTION_THRESHOLD", "0.5"))
SAFETY_THRESHOLD = float(os.getenv("GUARD_SAFETY_THRESHOLD", "0.5"))
CALENDAR_HINTS = (
    "задач",
    "дел",
    "встреч",
    "событ",
    "календар",
    "напомин",
    "расписан",
    "создай",
    "добавь",
    "поставь",
    "перенес",
    "удал",
    "измени",
    "покажи",
    "найди",
    "завтра",
    "сегодня",
    "недел",
    "месяц",
)

app = FastAPI(title="Planner Guard", version="1.0")


class ClassifyRequest(BaseModel):
    model: str | None = None
    text: str = Field(min_length=1, max_length=50_000)
    source: str = "user_input"


class ClassifyResponse(BaseModel):
    action: str
    label: str
    score: float
    reason: str
    injection_probability: float
    unsafe_probability: float
    source: str


@lru_cache(maxsize=1)
def load_guard() -> tuple[Any, Any, torch.device]:
    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME, trust_remote_code=True)
    model = AutoModelForSequenceClassification.from_pretrained(
        MODEL_NAME,
        trust_remote_code=True,
    )
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device)
    model.eval()
    return tokenizer, model, device


def _probabilities(output: Any) -> tuple[float, float, list[float]]:
    injection_logits = getattr(output, "injection_logits", None)
    safety_logits = getattr(output, "safety_logits", None)
    category_logits = getattr(output, "category_logits", None)
    if isinstance(output, dict):
        injection_logits = output.get("injection_logits", injection_logits)
        safety_logits = output.get("safety_logits", safety_logits)
        category_logits = output.get("category_logits", category_logits)
    if injection_logits is None or safety_logits is None:
        raise RuntimeError("Guard model did not return injection_logits and safety_logits")
    injection_probability = torch.softmax(injection_logits, dim=-1)[0, 1].item()
    unsafe_probability = torch.softmax(safety_logits, dim=-1)[0, 1].item()
    category_probabilities = []
    if category_logits is not None:
        category_probabilities = torch.sigmoid(category_logits)[0].tolist()
    return injection_probability, unsafe_probability, category_probabilities


def _label(injection_probability: float, unsafe_probability: float, categories: list[float]) -> str:
    if injection_probability >= INJECTION_THRESHOLD:
        return "prompt_injection"
    if unsafe_probability < SAFETY_THRESHOLD:
        return "none"
    # Lunaris Guard category order documented by the model card.
    names = [
        "violent_crimes",
        "non_violent_crimes",
        "sex_crimes",
        "child_exploitation",
        "defamation",
        "specialized_advice",
        "privacy",
        "intellectual_property",
        "indiscriminate_weapons",
        "hate",
        "suicide_self_harm",
        "sexual_content",
        "elections",
        "code_interpreter_abuse",
    ]
    if categories:
        index = max(range(len(categories)), key=categories.__getitem__)
        if index < len(names) and categories[index] >= SAFETY_THRESHOLD:
            return names[index]
    return "unsafe_other"


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "model": MODEL_NAME}


@app.on_event("startup")
def warmup() -> None:
    # Load the model before the container becomes healthy. This makes the
    # compose dependency useful: API/worker will not receive traffic while
    # the first model download is still in progress.
    load_guard()


@app.post("/classify", response_model=ClassifyResponse)
def classify(request: ClassifyRequest) -> ClassifyResponse:
    tokenizer, model, device = load_guard()
    inputs = tokenizer(
        request.text,
        return_tensors="pt",
        truncation=True,
        max_length=MAX_LENGTH,
    )
    inputs = {key: value.to(device) for key, value in inputs.items()}
    with torch.inference_mode():
        output = model(**inputs)
    injection, unsafe, categories = _probabilities(output)
    label = _label(injection, unsafe, categories)
    if label == "none" and request.source == "user_input":
        lowered = request.text.casefold()
        if not any(hint in lowered for hint in CALENDAR_HINTS):
            label = "off_topic"
    action = "clarify" if label == "off_topic" else ("refuse" if label != "none" else "allow")
    score = max(injection, unsafe)
    reason = f"{label}; injection={injection:.4f}; unsafe={unsafe:.4f}"
    return ClassifyResponse(
        action=action,
        label=label,
        score=score,
        reason=reason,
        injection_probability=injection,
        unsafe_probability=unsafe,
        source=request.source,
    )
