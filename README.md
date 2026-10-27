# Smart Planner

## Safety guard

The API has a Russian-capable, optional safety boundary before the planner
agent. Set `GUARD_ENABLED=true` and point `GUARD_BASE_URL` at a local guard
service. The service receives:

```json
{"model":"auren-research/lunaris-guardv3","text":"...","source":"user_input"}
```

at `POST /classify` and should return:

```json
{
  "action": "allow",
  "label": "none",
  "score": 0.01,
  "reason": "..."
}
```

The backend only accepts specific safety labels: hate speech, extremist praise,
violent crimes/weapons, sexual abuse/child exploitation, and political persuasion
(`elections`, `politics`, `political_persuasion`). Remote decisions require
`GUARD_MIN_CONFIDENCE` (default `0.9`). Generic unsafe, off-topic, sexual-content,
advice, and model-only injection labels do not block calendar operations.
Explicit local injection checks remain active. Ordinary words such as recipes,
movies, music, weather, or news never trigger a keyword veto; the planner asks
for clarification when the actual request is unrelated to calendar work.
Local political checks target explicit requests to generate agitation or propaganda,
not neutral reminders about elections or political-science lectures.
If the optional guard is unavailable or its response is invalid, local checks
still apply and calendar operations continue. Owner/schema/tool authorization
always remains mandatory, independently of content classification.

The default configured model is `auren-research/lunaris-guardv3`. It is a
multilingual model with prompt-injection and safety heads; evaluate it on a
Russian test set before production rollout. The backend still performs
deterministic pattern checks and independent owner/schema/tool authorization,
so the guard model is not treated as an authorization mechanism.

The default Docker Compose setup now includes this guard service. The first
startup downloads the model into the `guard_models` volume and can take time.
The API calls it internally at `http://guard:8090/classify`; users continue to
send messages to the existing chat endpoint and do not call the guard endpoint
directly.

Асинхронный backend умного ежедневника. API принимает текстовые и голосовые сообщения,
ставит их в Redis-очередь, а worker выполняет STT/LLM-обработку и сохраняет результат в PostgreSQL.
Агентный pipeline оркестрируется LangGraph; его граф скрыт за внутренним `run_agent`-контрактом.

## Запуск

```bash
cp .env.example .env
docker compose --profile release run --rm migrate
docker compose up --build
```

Веб-чат доступен на `http://localhost:3000`, Swagger UI — на `http://localhost:8000/docs`.
Для MVP порты должны быть доступны только
из доверенной сети или через VPN/firewall.

## Разработка

```bash
python -m pip install -e '.[test]'
python -m pytest
npm --prefix web install
npm --prefix web test
npm --prefix web run build
./dev/test-e2e
```

Настройте `LLM_BASE_URL` и `STT_BASE_URL` как корневые URL OpenAI-compatible API.
Для LM Studio на host используйте `LLM_BASE_URL=http://127.0.0.1:1234`, а в Docker
Compose — `http://host.docker.internal:1234`. API проверяет `/v1/models` при старте и
не запускается, если `LLM_MODEL=qwen/qwen3.8-27b` недоступна. Reasoning для
command interpreter отключается через `LLM_REASONING_EFFORT=none`.
Локальный speech-to-text на GigaAM настраивается по инструкции [GIGAAM.md](GIGAAM.md).
Секреты хранятся только в `.env`; файл не должен попадать в Git.

## Hands-free и голосовой ответ

Создание и перенос событий возвращают `collision_report` с пересечениями по времени,
включая повторы на год вперёд от затронутой части серии. Сохранение выполняется сразу.
При ручном редактировании интерфейс показывает предупреждение; в чате модель получает
отчёт после сохранения и выбирает значимые `collision_notices` для показа и озвучивания.
Наложение совместимых занятий (например, пребывание в политехе и пара там же) модель
может оставить без предупреждения. Без длительности событие считается точкой, касание
границ интервалов не считается пересечением. Сбой дополнительного ответа модели не
отменяет сохранённые изменения.

Кнопка Ivory запускает полудуплексный hands-free цикл: браузер режет поток микрофона
по паузам и передаёт PCM16/16 kHz через `/voice/session`. Wake word произносится
отдельной фразой; после его распознавания интерфейс подаёт сигнал готовности и слушает
команды без повторного «Айвори». Другой сигнал подтверждает окончание команды.
Настраиваемый таймаут бездействия (15 секунд по умолчанию) возвращает диалог в ожидание
wake word, не выключая Ivory. При скрытой вкладке микрофон ставится на паузу. Для
доступа к WebSocket API выдаёт одноразовый owner-scoped ticket с коротким TTL.

Голосовой ответ опционален и включается в настройках. Отдельный `speech_text` содержит
только тип изменения, тип и название записи, день недели, дату и время. Он хранится
в PostgreSQL, а WAV всегда синтезируется заново и не сохраняется. Compose запускает
CPU-сервис Silero `v5_6_ru`. Если существует `models/v5_6_ru.pt`, Compose монтирует
его read-only и не обращается к сети; иначе первый запуск скачивает веса в volume
`tts_models`. Для отдельного запуска путь задаётся через `TTS_MODEL_PATH`.
Для запуска вне Docker:

```bash
./setup-silero.sh
./run-silero.sh
```

Настройки подключения: `TTS_BASE_URL`, `TTS_API_KEY`, `TTS_MODEL` и
`TTS_REQUEST_TIMEOUT_SECONDS`. Если TTS недоступен, текстовый ответ и изменения
календаря продолжают работать. Для микрофона и AudioWorklet вне localhost нужен HTTPS.

Чтения агента выполняются сразу. Изменения выполняются сразу одной атомарной командой и
записываются в неизменяемую историю `/calendar/history`. Отмена создаёт компенсирующую
операцию; задачи и события можно восстановить воспроизведением журнала.


=======
## Напоминания и уведомления

Задачи остаются открытыми после дедлайна и входят в запросы «что сделать до даты»,
пока не выполнены. Прошедшие события не входят в ближайшие дела. Напоминания
срабатывают один раз и создают постоянное уведомление в личном центре уведомлений.
Прочтение не удаляет уведомление: удалить его можно отдельной кнопкой.

Создать напоминание можно через ассистента, из выбранного дня календаря или из формы
существующей задачи/события. Связанные напоминания поддерживают абсолютное время и
смещение в минутах: `-60` означает за час до начала события или дедлайна. Относительное
напоминание переносится вместе с источником. Выполнение задачи и удаление источника
отменяют активные напоминания; undo восстанавливает автоматически отменённые записи.
Сработавшее напоминание нельзя перенести: нужно создать новое.

API: `/reminders` и `/reminders/{id}` — CRUD; `/notifications` — inbox с пагинацией и
фильтром `unread=true`; `PATCH /notifications/{id}/read`,
`POST /notifications/read-all`, `DELETE /notifications/{id}` — управление уведомлениями.
Поиск агента и история календаря поддерживают тип `reminder`.

Отдельный сервис `notifier` проверяет PostgreSQL каждые пять секунд и догоняет
просроченные напоминания после перезапуска. Срабатывание и inbox записываются одной
транзакцией, а блокировки строк и уникальные ограничения предотвращают повторное
создание уведомлений. Push-доставка идёт через outbox с повторами до 24 часов;
постоянные ошибки не повторяются, устаревшие подписки отключаются.

Чтобы включить Web Push, сгенерируйте постоянную пару ключей:

```bash
uv run python -m planner.push_keys
```

Сохраните выведенные `WEB_PUSH_VAPID_PUBLIC_KEY` и `WEB_PUSH_VAPID_PRIVATE_KEY`
в незакоммиченный `.env`, добавьте `WEB_PUSH_VAPID_SUBJECT=mailto:ваш-адрес@example.com`
и перезапустите API/notifier. Ключи должны совпадать у обоих сервисов и сохраняться
между перезапусками. Затем в центре уведомлений нажмите «Включить push» и разрешите
уведомления браузеру. Поддерживаются push-службы Chrome, Firefox, Edge и Safari.
Для браузера необходим HTTPS или localhost; для запросов к push-службе нужен доступ
сервера в интернет. Без VAPID или разрешения браузера inbox продолжает работать.

Браузер/ОС могут задержать или подавить системное уведомление. Источник истины — inbox
в PostgreSQL; стабильный notification tag объединяет повторные попытки push.
Интерфейс обновляет inbox при получении push, при возврате фокуса и каждые 15 секунд.
Повторения напоминаний и snooze не входят в эту версию.

Проверка без внешних LLM/STT/TTS и push-служб: `./dev/test-e2e`. Она использует отдельную
PostgreSQL, проверяет полный путь ассистент → напоминание → notifier → inbox,
поиск, перенос/undo, hands-free WebSocket и конкурентное срабатывание нескольких
notifier-процессов.

## Google: вход и синхронизация календаря

Интеграция опциональна и включается, когда в `.env` заданы `GOOGLE_CALENDAR_CLIENT_ID`,
`GOOGLE_CALENDAR_CLIENT_SECRET` и `CALENDAR_TOKEN_KEY` (любой длинный случайный секрет для
шифрования refresh-токенов). В Google Cloud Console включите Google Calendar API, создайте
OAuth client типа «Web application» и добавьте redirect URI
`http://localhost:3000/api/auth/google/callback` (в общем случае
`${FRONTEND_BASE_URL}/api/auth/google/callback`). Пока приложение в режиме Testing,
войти смогут только добавленные тестовые пользователи.

На экране входа появляется «Войти через Google». Новый пользователь регистрируется без
пароля; если аккаунт с той же подтверждённой почтой уже есть, Google привязывается к нему.
Кнопка «Google» в шапке подключает основной календарь (scope `calendar.events`).

Сервис `calendar-sync` синхронизирует события в обе стороны:

- изменения в ежедневнике (REST, агент, undo) отправляются сразу после сохранения;
- изменения из Google забираются раз в минуту инкрементально по `syncToken`
  (push-уведомлениям Google нужен публичный HTTPS-адрес);
- входящие изменения записываются в журнал `/calendar/history` с источником `google`;
- каждая версия расписания серии соответствует событию Google с RRULE, изменённые и
  отменённые повторы — instance-исключениям Google; правка «с этого и далее» делит
  серию в Google так же, как Google делит её сам;
- при одновременной правке побеждает более позднее изменение;
- изменения отправляются частичным обновлением (PATCH), поэтому участники, ссылки
  Meet и цвета событий Google сохраняются; у дней рождения из контактов меняется только
  название, у событий из Gmail — только уведомления;
- относительные напоминания разового события («за 30 минут») становятся
  уведомлениями этого события в Google (до пяти, не раньше чем за 4 недели);
- задачи, отдельные напоминания и напоминания повторяющихся событий остаются только
  в ежедневнике; события Google со сложными правилами повтора пропускаются, и их число
  видно в окне интеграции;
- изменение, которое Google отклонил окончательно (например, недопустимое поле),
  пропускается и не блокирует остальные.

Отключение останавливает синхронизацию и отзывает токен; события остаются в обоих
календарях, а при повторном подключении того же аккаунта не дублируются.

## Оценка guardrails с настоящим приложением

После настройки модели и запуска приложения:

```powershell
python -m guardrail_eval run --live --api-url http://localhost:8000 --dataset tests/data/guardrail_live_cases.jsonl --out reports/guardrail_eval/live.json
```

Инструкция для Windows, настройки сервера модели, форматы отчётов и сравнение
«до/после»: [guardrail_eval/README.md](guardrail_eval/README.md).
