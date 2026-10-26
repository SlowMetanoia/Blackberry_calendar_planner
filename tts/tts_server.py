import io
import math
import os
import threading
import wave
from array import array
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
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
        audio = model.apply_tts(
            text=data.input,
            speaker=data.voice,
            sample_rate=SAMPLE_RATE,
            put_accent=True,
            put_yo=True,
        )
        stretched = time_stretch(_samples(audio), data.speed)
    return Response(encode_wav(stretched), media_type="audio/wav")
