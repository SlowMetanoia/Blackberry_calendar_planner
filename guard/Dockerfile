FROM python:3.12-slim

WORKDIR /guard

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV HF_HOME=/models/.cache

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY guard_server.py .

EXPOSE 8090

CMD ["uvicorn", "guard_server:app", "--host", "0.0.0.0", "--port", "8090"]