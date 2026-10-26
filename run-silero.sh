#!/bin/sh
set -eu
export TORCH_HOME="${TORCH_HOME:-$PWD/.silero-models}"
export TTS_MODEL_PATH="${TTS_MODEL_PATH:-$PWD/models/v5_6_ru.pt}"
exec .venv-silero/bin/python -m uvicorn tts.tts_server:app --host 127.0.0.1 --port "${TTS_PORT:-8081}"
