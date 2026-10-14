"""Small OpenAI-compatible HTTP facade for local GigaAM speech-to-text."""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Protocol

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile

LOGGER = logging.getLogger(__name__)
DEFAULT_PUBLIC_MODEL = "gigaam-v3-e2e-rnnt"
DEFAULT_CHECKPOINT = "v3_e2e_rnnt"


class Transcriber(Protocol):
    def transcribe(self, audio_path: Path) -> str: ...


class GigaAMTranscriber:
    """Load one GigaAM checkpoint and reuse it for serialized inference."""

    def __init__(self, checkpoint: str, device: str, cache_dir: str | None) -> None:
        try:
            import gigaam
        except ImportError as exc:  # pragma: no cover - exercised by the setup smoke test
            raise RuntimeError("GigaAM is not installed; run ./setup-gigaam.sh") from exc

        load_options: dict[str, object] = {
            "device": device,
            "fp16_encoder": device != "cpu",
        }
        if cache_dir:
            load_options["download_root"] = cache_dir
        self._model = gigaam.load_model(checkpoint, **load_options)

    def transcribe(self, audio_path: Path) -> str:
        result = self._model.transcribe(str(audio_path))
        text = getattr(result, "text", result)
        return str(text).strip()


def _api_key() -> str | None:
    return os.getenv("GIGAAM_API_KEY") or os.getenv("STT_API_KEY")


def _authorized(authorization: str | None) -> bool:
    expected = _api_key()
    return expected is None or authorization == f"Bearer {expected}"


def create_app(transcriber: Transcriber | None = None) -> FastAPI:
    public_model = os.getenv("GIGAAM_PUBLIC_MODEL", DEFAULT_PUBLIC_MODEL)
    max_upload_bytes = int(os.getenv("GIGAAM_MAX_UPLOAD_MB", "25")) * 1024 * 1024

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if app.state.transcriber is None:
            checkpoint = os.getenv("GIGAAM_MODEL", DEFAULT_CHECKPOINT)
            device = os.getenv("GIGAAM_DEVICE", "cpu")
            cache_dir = os.getenv("GIGAAM_CACHE_DIR")
            LOGGER.info("Loading GigaAM checkpoint=%s device=%s", checkpoint, device)
            app.state.transcriber = await asyncio.to_thread(
                GigaAMTranscriber,
                checkpoint,
                device,
                cache_dir,
            )
        yield

    app = FastAPI(title="Local GigaAM STT", version="0.1.0", lifespan=lifespan)
    app.state.transcriber = transcriber
    app.state.inference_lock = asyncio.Lock()

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "model": public_model}

    @app.get("/v1/models")
    async def models() -> dict[str, object]:
        return {
            "object": "list",
            "data": [{"id": public_model, "object": "model", "owned_by": "local"}],
        }

    @app.post("/v1/audio/transcriptions")
    async def audio_transcription(
        file: UploadFile = File(...),
        model: str = Form(...),
        authorization: str | None = Header(default=None),
    ) -> dict[str, str]:
        if not _authorized(authorization):
            raise HTTPException(401, "Invalid API key")
        if model != public_model:
            raise HTTPException(404, f"Unknown model: {model}")

        suffix = Path(file.filename or "audio").suffix[:16]
        total = 0
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temporary:
            temporary_path = Path(temporary.name)
            try:
                while chunk := await file.read(1024 * 1024):
                    total += len(chunk)
                    if total > max_upload_bytes:
                        raise HTTPException(413, "Audio file is too large")
                    temporary.write(chunk)
            except BaseException:
                temporary_path.unlink(missing_ok=True)
                raise

        try:
            async with app.state.inference_lock:
                text = await asyncio.to_thread(
                    app.state.transcriber.transcribe,
                    temporary_path,
                )
            return {"text": text}
        except HTTPException:
            raise
        except Exception as exc:
            LOGGER.exception("GigaAM transcription failed")
            raise HTTPException(422, "Audio transcription failed") from exc
        finally:
            temporary_path.unlink(missing_ok=True)

    return app


app = create_app()
