import io
import sys
import wave
from types import SimpleNamespace

import pytest

from tts import tts_server
from tts.tts_server import SAMPLE_RATE, VOICES, encode_wav, time_stretch


def test_runtime_has_expected_russian_voices() -> None:
    assert VOICES == ("aidar", "baya", "kseniya", "xenia", "eugene")


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (
            "четверг, 29 октября 2026 года, 12:30",
            (
                "четверг, двадцать девятое октября две тысячи двадцать шестого года, "
                "двенадцать часов тридцать минут"
            ),
        ),
        ("1 января 2000 года", "первое января двухтысячного года"),
        ("31 декабря 2025 года", "тридцать первое декабря две тысячи двадцать пятого года"),
        ("01:01", "один час одна минута"),
        ("00:00", "ноль часов ровно"),
        ("12:00", "двенадцать часов ровно"),
        ("23:59", "двадцать три часа пятьдесят девять минут"),
        ("11:11", "одиннадцать часов одиннадцать минут"),
        ("12:22", "двенадцать часов двадцать две минуты"),
        ("Задача 42, кабинет 0, код 007", "Задача сорок два, кабинет ноль, код ноль ноль семь"),
        ("2,5 и -3.14", "два запятая пять и минус три запятая один четыре"),
        ("Проект2026 и +5", "Проект две тысячи двадцать шесть и плюс пять"),
        ("Готово. Без срока!", "Готово. Без срока!"),
        ("двадцать девятое октября", "двадцать девятое октября"),
    ],
)
def test_numbers_are_pronounced_in_russian(text: str, expected: str) -> None:
    assert tts_server.normalize_speech_text(text) == expected


def test_huge_numbers_are_read_digit_by_digit() -> None:
    text = "9" * 100
    assert tts_server.normalize_speech_text(text) == " ".join(["девять"] * 100)


def test_speech_preserves_numbers_and_all_expanded_chunks(monkeypatch) -> None:
    calls = []
    samples_per_chunk = 2400

    def synthesize(**kwargs):
        calls.append(kwargs)
        return [0.1] * samples_per_chunk

    monkeypatch.setattr(tts_server, "load_model", lambda: SimpleNamespace(apply_tts=synthesize))
    monkeypatch.setattr(tts_server, "API_KEY", None)
    text = "29 октября 2026 года, 12:30. " + "123456789 " * 12
    response = tts_server.speech(tts_server.SpeechRequest(input=text, voice="baya", speed=1.25))

    assert len(calls) > 1
    spoken = " ".join(call["text"] for call in calls)
    assert spoken == tts_server.normalize_speech_text(text)
    assert "двадцать девятое октября" in spoken
    assert not any(char.isdecimal() for char in spoken)
    assert all(len(call["text"]) <= 200 and call["speaker"] == "baya" for call in calls)
    expected_samples = time_stretch([0.1] * (samples_per_chunk * len(calls)), 1.25)
    with wave.open(io.BytesIO(response.body), "rb") as audio:
        assert audio.getframerate() == SAMPLE_RATE
        assert audio.getnchannels() == 1
        assert audio.getnframes() == len(expected_samples)


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
