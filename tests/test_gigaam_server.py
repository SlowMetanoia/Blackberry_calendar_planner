from pathlib import Path

from fastapi.testclient import TestClient

from planner.gigaam_server import create_app


class FakeTranscriber:
    def __init__(self) -> None:
        self.received: bytes | None = None

    def transcribe(self, audio_path: Path) -> str:
        self.received = audio_path.read_bytes()
        return "создай встречу завтра в три"


def test_transcription_endpoint_matches_openai_contract() -> None:
    transcriber = FakeTranscriber()

    with TestClient(create_app(transcriber=transcriber)) as client:
        response = client.post(
            "/v1/audio/transcriptions",
            files={"file": ("message.webm", b"audio-bytes", "audio/webm")},
            data={"model": "gigaam-v3-e2e-rnnt"},
        )

    assert response.status_code == 200
    assert response.json() == {"text": "создай встречу завтра в три"}
    assert transcriber.received == b"audio-bytes"


def test_transcription_endpoint_rejects_unknown_model() -> None:
    with TestClient(create_app(transcriber=FakeTranscriber())) as client:
        response = client.post(
            "/v1/audio/transcriptions",
            files={"file": ("message.wav", b"audio", "audio/wav")},
            data={"model": "whisper-1"},
        )

    assert response.status_code == 404
    assert response.json()["detail"] == "Unknown model: whisper-1"


def test_health_reports_loaded_model() -> None:
    with TestClient(create_app(transcriber=FakeTranscriber())) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "model": "gigaam-v3-e2e-rnnt",
    }
