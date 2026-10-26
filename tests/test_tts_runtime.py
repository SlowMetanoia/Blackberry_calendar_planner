import io
import sys
import wave
from types import SimpleNamespace

import pytest

from tts import tts_server
from tts.tts_server import SAMPLE_RATE, VOICES, encode_wav, time_stretch


def test_runtime_has_expected_russian_voices() -> None:
    assert VOICES == ("aidar", "baya", "kseniya", "xenia", "eugene")


def test_health_stays_available_while_model_is_warming(monkeypatch) -> None:
    monkeypatch.setattr(tts_server, "_model", None)
    monkeypatch.setattr(tts_server, "MODEL_PATH", None)

    assert tts_server.health() == {
        "status": "degraded",
        "model": tts_server.MODEL_NAME,
        "ready": False,
        "source": "download",
    }


def test_load_model_prefers_configured_local_file(monkeypatch, tmp_path) -> None:
    model_path = tmp_path / "model.pt"
    model_path.write_bytes(b"package")
    loaded_model = SimpleNamespace(to=lambda device: device)

    class FakeImporter:
        def __init__(self, path):
            assert path == str(model_path)

        def load_pickle(self, package, resource):
            assert (package, resource) == ("tts_models", "model")
            return loaded_model

    fake_torch = SimpleNamespace(
        package=SimpleNamespace(PackageImporter=FakeImporter),
        hub=SimpleNamespace(load=lambda **_kwargs: pytest.fail("network load used")),
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setattr(tts_server, "MODEL_PATH", str(model_path))
    monkeypatch.setattr(tts_server, "_model", None)

    assert tts_server.load_model() is loaded_model


def test_time_stretch_changes_duration_without_changing_sample_rate() -> None:
    source = [0.1] * 24_000
    faster = time_stretch(source, 1.5)
    slower = time_stretch(source, 0.75)
    assert len(faster) < len(source) < len(slower)
    with wave.open(io.BytesIO(encode_wav(faster)), "rb") as audio:
        assert audio.getframerate() == SAMPLE_RATE
        assert audio.getnchannels() == 1
        assert audio.getsampwidth() == 2
