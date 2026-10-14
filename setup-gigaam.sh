#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VENV_DIR="${GIGAAM_VENV:-$PROJECT_DIR/.venv-gigaam}"
GIGAAM_REVISION="${GIGAAM_REVISION:-7447938d791c4f3e643386ee22c33777004293a5}"
GIGAAM_MODEL="${GIGAAM_MODEL:-v3_e2e_rnnt}"
GIGAAM_DEVICE="${GIGAAM_DEVICE:-cpu}"
GIGAAM_CACHE_DIR="${GIGAAM_CACHE_DIR:-}"

if [ -n "${GIGAAM_PYTHON:-}" ]; then
    PYTHON_BIN=$GIGAAM_PYTHON
elif command -v python3.11 >/dev/null 2>&1; then
    PYTHON_BIN=python3.11
else
    PYTHON_BIN=python3
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "ffmpeg is required. On macOS run: brew install ffmpeg" >&2
    exit 1
fi

"$PYTHON_BIN" -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip
"$VENV_DIR/bin/python" -m pip install \
    "gigaam[torch] @ git+https://github.com/salute-developers/GigaAM.git@$GIGAAM_REVISION" \
    "fastapi>=0.115,<1" \
    "uvicorn[standard]>=0.32,<1" \
    "python-multipart>=0.0.12,<1"

GIGAAM_MODEL="$GIGAAM_MODEL" GIGAAM_DEVICE="$GIGAAM_DEVICE" \
    GIGAAM_CACHE_DIR="$GIGAAM_CACHE_DIR" \
    "$VENV_DIR/bin/python" -c \
    'import os, gigaam; options = {"device": os.environ["GIGAAM_DEVICE"]}; cache = os.environ["GIGAAM_CACHE_DIR"]; options.update({"download_root": cache} if cache else {}); gigaam.load_model(os.environ["GIGAAM_MODEL"], **options); print("GigaAM model is ready")'

echo "Setup complete. Start the server with: ./run-gigaam.sh"
