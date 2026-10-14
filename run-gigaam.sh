#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VENV_DIR="${GIGAAM_VENV:-$PROJECT_DIR/.venv-gigaam}"

if [ ! -x "$VENV_DIR/bin/python" ]; then
    echo "GigaAM environment is missing. Run ./setup-gigaam.sh first." >&2
    exit 1
fi

export PYTHONPATH="$PROJECT_DIR/src${PYTHONPATH:+:$PYTHONPATH}"
export GIGAAM_MODEL="${GIGAAM_MODEL:-v3_e2e_rnnt}"
export GIGAAM_PUBLIC_MODEL="${GIGAAM_PUBLIC_MODEL:-gigaam-v3-e2e-rnnt}"
export GIGAAM_DEVICE="${GIGAAM_DEVICE:-cpu}"

exec "$VENV_DIR/bin/python" -m uvicorn planner.gigaam_server:app \
    --host "${GIGAAM_HOST:-0.0.0.0}" \
    --port "${GIGAAM_PORT:-9000}"
