import io
import math
import os
import re
import threading
import wave
from array import array
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from num2words import num2words
from pydantic import BaseModel, Field

VOICES = ("aidar", "baya", "kseniya", "xenia", "eugene")
MODEL_NAME = os.getenv("TTS_MODEL", "v5_6_ru")
MODEL_PATH = os.getenv("TTS_MODEL_PATH")
API_KEY = os.getenv("TTS_API_KEY")
SAMPLE_RATE = 24_000
_model = None
_lock = threading.Lock()
_load_lock = threading.Lock()
_model_error: str | None = None

MONTHS = (
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
DAY_MONTH = re.compile(r"\b(\d{1,2})\s+(" + "|".join(MONTHS) + r")\b", re.IGNORECASE)
YEAR = re.compile(r"\b(\d{1,4})\s+года\b", re.IGNORECASE)
CLOCK = re.compile(r"(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])")
NUMBER = re.compile(r"[+−-]?\d+(?:[.,]\d+)?")


def _digits_words(value: str) -> str:
    return " ".join(num2words(int(char), lang="ru") for char in value)


def _integer_words(value: str) -> str:
    if len(value) > 1 and value.startswith("0"):
        return _digits_words(value)
    try:
        return num2words(int(value), lang="ru")
    except (OverflowError, KeyError):
        # Russian scale names in num2words are finite; larger integers raise KeyError.
        return _digits_words(value)


def _unit_form(value: int, forms: tuple[str, str, str]) -> str:
    if 11 <= value % 100 <= 14:
        return forms[2]
    ending = value % 10
    return forms[0] if ending == 1 else forms[1] if 2 <= ending <= 4 else forms[2]


def _clock_words(match: re.Match[str]) -> str:
    hour, minute = map(int, match.groups())
    hours = f"{num2words(hour, lang='ru')} {_unit_form(hour, ('час', 'часа', 'часов'))}"
    if minute == 0:
        return f"{hours} ровно"
    minutes = num2words(minute, lang="ru", gender="feminine")
    return f"{hours} {minutes} {_unit_form(minute, ('минута', 'минуты', 'минут'))}"


def _number_words(match: re.Match[str]) -> str:
    value = match.group()
    sign = ""
    if value[0] in "+−-":
        sign = "плюс " if value[0] == "+" else "минус "
        value = value[1:]
    parts = re.split(r"[.,]", value)
    spoken = sign + _integer_words(parts[0])
    if len(parts) == 2:
        spoken += " запятая " + _digits_words(parts[1])
    # Keep numbers inside names audible as separate words (e.g. «Проект2026»).
    if match.start() and match.string[match.start() - 1].isalpha():
        spoken = " " + spoken
    if match.end() < len(match.string) and match.string[match.end()].isalpha():
        spoken += " "
    return spoken


def normalize_speech_text(text: str) -> str:
    """Expand numbers before Silero's alphabet filter can discard them."""
    text = DAY_MONTH.sub(
        lambda m: (
            f"{num2words(int(m[1]), lang='ru', to='ordinal', gender='neuter')} {m[2]}"
            if 1 <= int(m[1]) <= 31
            else m.group()
        ),
        text,
    )
    text = YEAR.sub(
        lambda m: f"{num2words(int(m[1]), lang='ru', to='ordinal', case='genitive')} года",
        text,
    )
    text = CLOCK.sub(_clock_words, text)
    return " ".join(NUMBER.sub(_number_words, text).split())


def _speech_chunks(text: str, max_chars: int = 200) -> list[str]:
    chunks: list[str] = []
    remaining = text
    while len(remaining) > max_chars:
        boundary = remaining.rfind(" ", 0, max_chars + 1)
        if boundary <= 0:
            boundary = max_chars
        chunks.append(remaining[:boundary])
        remaining = remaining[boundary:].strip()
    if remaining:
        chunks.append(remaining)
    return chunks


def load_model():
    global _model, _model_error
    if _model is not None:
        return _model
    with _load_lock:
        if _model is not None:
            return _model
        import torch

        try:
            if MODEL_PATH and os.path.isfile(MODEL_PATH):
                importer = torch.package.PackageImporter(MODEL_PATH)
                _model = importer.load_pickle("tts_models", "model")
                _model.to("cpu")
            else:
                _model, _example = torch.hub.load(
                    repo_or_dir="snakers4/silero-models",
                    model="silero_tts",
                    language="ru",
                    speaker=MODEL_NAME,
                    trust_repo=True,
                )
            _model_error = None
        except Exception as exc:
            _model_error = f"{type(exc).__name__}: {exc}"
            raise
    return _model


def warm_model() -> None:
    try:
        load_model()
    except (ImportError, OSError, RuntimeError, ValueError):
        # The API must stay available when the model CDN is temporarily down.
        # A later speech request retries loading and receives a clean 503 on failure.
        return


def _samples(value) -> list[float]:
    if hasattr(value, "detach"):
        value = value.detach().cpu().flatten().tolist()
    return [float(item) for item in value]


def time_stretch(samples: list[float], speed: float) -> list[float]:
    """Small overlap-add stretcher; changes duration while retaining local pitch."""
    if abs(speed - 1.0) < 0.001 or len(samples) < 2048:
        return samples
    frame = 960
    synthesis_hop = 240
    analysis_hop = max(1, round(synthesis_hop * speed))
    frame_count = max(1, 1 + (len(samples) - frame) // analysis_hop)
    output_length = synthesis_hop * (frame_count - 1) + frame
    output = [0.0] * output_length
    weights = [0.0] * output_length
    window = [0.5 - 0.5 * math.cos(2 * math.pi * index / (frame - 1)) for index in range(frame)]
    for frame_index in range(frame_count):
        source = frame_index * analysis_hop
        target = frame_index * synthesis_hop
        for index, weight in enumerate(window):
            if source + index >= len(samples):
                break
            output[target + index] += samples[source + index] * weight
            weights[target + index] += weight
    return [sample / weight if weight > 1e-9 else sample for sample, weight in zip(output, weights)]


def encode_wav(samples: list[float]) -> bytes:
    pcm = array(
        "h",
        (
            round(max(-1.0, min(1.0, sample)) * (32767 if sample >= 0 else 32768))
            for sample in samples
        ),
    )
    output = io.BytesIO()
    with wave.open(output, "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(SAMPLE_RATE)
        target.writeframes(pcm.tobytes())
    return output.getvalue()


class SpeechRequest(BaseModel):
    model: str = MODEL_NAME
    voice: str = "kseniya"
    speed: float = Field(default=1.0, ge=0.75, le=1.5)
    input: str = Field(min_length=1, max_length=200)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    threading.Thread(target=warm_model, name="silero-warmup", daemon=True).start()
    yield


app = FastAPI(title="Silero TTS", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, str | bool]:
    return {
        "status": "ok" if _model is not None else "degraded",
        "model": MODEL_NAME,
        "ready": _model is not None,
        "source": "local" if MODEL_PATH and os.path.isfile(MODEL_PATH) else "download",
    }


@app.get("/v1/voices")
def voices() -> dict[str, list[str] | str]:
    return {"model": MODEL_NAME, "voices": list(VOICES)}


@app.post("/v1/audio/speech")
def speech(data: SpeechRequest, authorization: str | None = Header(default=None)) -> Response:
    if API_KEY and authorization != f"Bearer {API_KEY}":
        raise HTTPException(401, "Invalid API key")
    if data.model != MODEL_NAME:
        raise HTTPException(422, "Unsupported model")
    if data.voice not in VOICES:
        raise HTTPException(422, "Unsupported voice")
    with _lock:
        try:
            model = load_model()
        except Exception as exc:
            raise HTTPException(503, "TTS model is temporarily unavailable") from exc
        samples: list[float] = []
        for chunk in _speech_chunks(normalize_speech_text(data.input)):
            audio = model.apply_tts(
                text=chunk,
                speaker=data.voice,
                sample_rate=SAMPLE_RATE,
                put_accent=True,
                put_yo=True,
            )
            samples.extend(_samples(audio))
        stretched = time_stretch(samples, data.speed)
    return Response(encode_wav(stretched), media_type="audio/wav")
