FROM python:3.11-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN set -eux; \
    arch="$(uname -m)"; \
    if [ "$arch" = "aarch64" ]; then \
      pip install --no-cache-dir torch==2.0.1 --index-url https://download.pytorch.org/whl/cpu; \
    else \
      pip install --no-cache-dir torch==2.5.1+cpu --index-url https://download.pytorch.org/whl/cpu; \
    fi; \
    pip install --no-cache-dir -r requirements.txt
COPY tts_server.py .
ENV TORCH_HOME=/models
EXPOSE 8081
CMD ["uvicorn", "tts_server:app", "--host", "0.0.0.0", "--port", "8081"]
