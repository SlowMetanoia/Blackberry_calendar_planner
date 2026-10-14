# Локальные модели и GigaAM speech-to-text

## Текущий набор моделей

| Задача | Модель | Как подключена |
|---|---|---|
| Понимание команд и планирование | `qwen/qwen3.8-27b` | OpenAI-compatible API LM Studio |
| Распознавание русской речи | GigaAM `v3_e2e_rnnt` | Локальный сервис из этого репозитория |

LLM настраивается в `.env`: `LLM_BASE_URL` указывает на LM Studio
(`http://host.docker.internal:1234` из Compose или `http://127.0.0.1:1234`
при нативном запуске), а `LLM_MODEL=qwen/qwen3.8-27b` должен совпадать с именем
загруженной модели. `LLM_MAX_TOKENS` ограничивает ответ, таймаут задаётся через
`LLM_REQUEST_TIMEOUT_SECONDS`, reasoning сейчас отключён значением
`LLM_REASONING_EFFORT=none`.

В проекте GigaAM используется только для распознавания речи. Небольшой локальный
HTTP-сервис предоставляет совместимый с OpenAI endpoint
`POST /v1/audio/transcriptions`, который уже ожидает приложение в
`planner.agent.transcribe`. Генерация речи и LLM в этот сервис не входят.

## Установка и запуск

На macOS нужны Python 3.11 (предпочтительно) и `ffmpeg`:

```bash
brew install python@3.11 ffmpeg
./setup-gigaam.sh
./run-gigaam.sh
```

Setup создаёт отдельное окружение `.venv-gigaam`, устанавливает GigaAM из
зафиксированной ревизии официального репозитория и заранее загружает checkpoint
`v3_e2e_rnnt`. Окружение исключено из Git. По умолчанию веса попадают в системный
кэш GigaAM вне репозитория. Если нужен кэш внутри проекта, задавайте
`GIGAAM_CACHE_DIR=.gigaam-cache` и при setup, и при запуске — эта папка также
есть в `.gitignore`.

На Apple Silicon стабильный режим по умолчанию — CPU. Экспериментально можно
проверить Metal:

```bash
GIGAAM_DEVICE=mps ./run-gigaam.sh
```

Если конкретная версия PyTorch/GigaAM не поддерживает нужные операции MPS,
вернитесь к `GIGAAM_DEVICE=cpu`.

Проверка сервера:

```bash
curl http://127.0.0.1:9000/health
curl -X POST http://127.0.0.1:9000/v1/audio/transcriptions \
  -F model=gigaam-v3-e2e-rnnt \
  -F file=@sample.webm
```

GigaAM использует `ffmpeg`, поэтому сервис принимает обычные файлы браузерной
записи, включая WebM, и приводит звук к mono/16 kHz перед распознаванием.
Инференс сериализован, чтобы параллельные запросы не исчерпывали общую память.
Лимит одного upload по умолчанию — 25 МБ.

## Подключение приложения

Для backend и worker, запущенных через Docker Compose:

```dotenv
STT_BASE_URL=http://host.docker.internal:9000/v1
STT_API_KEY=
STT_MODEL=gigaam-v3-e2e-rnnt
```

Если приложение работает напрямую на macOS, используйте
`STT_BASE_URL=http://127.0.0.1:9000/v1`. Значения уже приведены в `.env.example`.

Для защиты сервера одним секретом задайте одинаковое значение в обоих процессах:

```bash
GIGAAM_API_KEY='replace-me' ./run-gigaam.sh
```

```dotenv
STT_API_KEY=replace-me
```

Не коммитьте реальный ключ: рабочий `.env` исключён из Git.

## Настройки сервера

| Переменная | По умолчанию | Назначение |
|---|---:|---|
| `GIGAAM_HOST` | `0.0.0.0` | Адрес прослушивания; нужен Docker-клиент с host-системы |
| `GIGAAM_PORT` | `9000` | Порт HTTP-сервера |
| `GIGAAM_MODEL` | `v3_e2e_rnnt` | Внутреннее имя checkpoint GigaAM |
| `GIGAAM_PUBLIC_MODEL` | `gigaam-v3-e2e-rnnt` | Имя модели в HTTP API и `STT_MODEL` |
| `GIGAAM_DEVICE` | `cpu` | Устройство PyTorch (`cpu`, экспериментально `mps`) |
| `GIGAAM_MAX_UPLOAD_MB` | `25` | Максимальный размер входного файла |
| `GIGAAM_CACHE_DIR` | системный кэш | Каталог весов модели |
| `GIGAAM_VENV` | `.venv-gigaam` | Отдельное Python-окружение сервера |
| `GIGAAM_API_KEY` | пусто | Необязательный Bearer token |

## Почему GigaAM, а не Whisper

Независимые публичные сравнения немногочисленны и используют разные корпуса,
поэтому одной универсальной цифры нет:

- В воспроизводимом любительском сравнении на первых 200 фразах русского
  Golos Crowd автор получил WER 1,50% для GigaAM v3 RNNT и 12,79% для Whisper
  large-v3. Выборка маленькая и неслучайная, а сохранённые результаты позволяют
  проверить расчёт, но не фиксируют полностью версии весов и окружение:
  [gigaam-vs-whisper-russian](https://github.com/garrrikkotua/gigaam-vs-whisper-russian).
- В другом открытом benchmark на Apple M1 Max результат зависел от реализации и
  checkpoint: на одном русском файле GigaAM multilingual CTC показал WER 2,5%,
  MLX Whisper large-v3-turbo — 4,3%, а GigaAM v3 RNNT — 5,2%. Whisper turbo при
  этом был быстрее RNNT. Это всего один русский файл, поэтому вывод нельзя
  переносить на все пользовательские записи:
  [whisper-benchmark RESULTS](https://github.com/mxl/whisper-benchmark/blob/main/RESULTS.md).
- В статье 2025 года на 1000 фрагментах Silero Open STT GigaAM RNNT v2 получил
  WER 15,5% на чистом и 21,8% на зашумлённом звуке, тогда как указанный авторами
  Whisper large-v3 — 65,3% и 67,4%. Необычно слабый результат Whisper делает
  вывод чувствительным к декодированию и деталям воспроизведения:
  [DOI 10.17513/srts.1514](https://doi.org/10.17513/srts.1514).

Практический вывод: GigaAM — разумный основной STT для коротких русских команд,
но окончательное решение стоит подтвердить собственным закрытым набором записей:
даты и время, имена, отрицания, шум и разные микрофоны. Считать нужно не только
общий WER, но и ошибки в критичных полях команды.

## Ограничения

Текущий endpoint рассчитан на короткие команды (ориентир GigaAM — примерно до
25 секунд). Он не делает diarization, streaming и автоматическую нарезку длинных
записей. Сервер слушает все интерфейсы ради доступа из Docker; не открывайте порт
9000 в недоверенную сеть без firewall/VPN и `GIGAAM_API_KEY`.
