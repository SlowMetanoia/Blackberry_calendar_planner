#!/bin/sh
set -eu
python3 -m venv .venv-silero
.venv-silero/bin/python -m pip install --upgrade pip
.venv-silero/bin/python -m pip install 'torch>=2.0,<3'
.venv-silero/bin/python -m pip install -r tts/requirements.txt
