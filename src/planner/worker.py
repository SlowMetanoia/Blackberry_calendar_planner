import json
import logging
import uuid
from datetime import UTC, datetime
from typing import ClassVar

from arq import Retry
from arq.connections import RedisSettings
from sqlalchemy import select

from .agent import AgentRunContext, TranscriptionError, run_agent, transcribe
from .config import get_settings
from .db import SessionLocal
from .google_sync_worker import schedule_google_sync
from .models import AgentMessage, Conversation, MessageStatus, User
from .schemas import AgentInput
from .voice import speech_text_for_payload

TERMINAL_MESSAGE_STATUSES = {
    MessageStatus.needs_clarification,
    MessageStatus.completed,
    MessageStatus.failed,
}
logger = logging.getLogger(__name__)
RELEASE_LOCK_SCRIPT = """
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
"""


def _retry_delay(job_try: int) -> int:
    return min(2 ** max(job_try - 1, 0), 30)


async def process_message(ctx: dict, message_id: str) -> None:
    redis = ctx["redis"]
    ident = uuid.UUID(message_id)
    token = str(uuid.uuid4())
    lock_key = f"conversation-message:{message_id}"

    async with SessionLocal() as session:
        message = await session.get(AgentMessage, ident)
        if message is None or message.status in TERMINAL_MESSAGE_STATUSES:
            return
        lock_key = f"conversation:{message.conversation_id}"
        acquired = await redis.set(lock_key, token, nx=True, px=120_000)
        if not acquired:
            if ctx.get("job_try", 1) >= WorkerSettings.max_tries:
                message.status = MessageStatus.failed
                message.error = "Conversation lock retry limit exceeded"
                await session.commit()
                return
            raise Retry(defer=_retry_delay(ctx.get("job_try", 1)))

        try:
            previous = await session.scalar(
                select(AgentMessage.id)
                .where(
                    AgentMessage.conversation_id == message.conversation_id,
                    AgentMessage.sequence < message.sequence,
                    AgentMessage.status.not_in(TERMINAL_MESSAGE_STATUSES),
                )
                .limit(1)
            )
            if previous is not None:
                if ctx.get("job_try", 1) >= WorkerSettings.max_tries:
                    message.status = MessageStatus.failed
                    message.error = "Previous conversation message did not reach a terminal status"
                    await session.commit()
                    return
                raise Retry(defer=_retry_delay(ctx.get("job_try", 1)))

            if message.audio_path:
                message.status = MessageStatus.transcribing
                await session.commit()
                message.input_text = AgentInput(text=await transcribe(message.audio_path)).text
            if not message.input_text:
                raise ValueError("Message has neither text nor audio")

            message.status = MessageStatus.processing
            await session.commit()
            result = await run_agent(
                message.input_text,
                AgentRunContext(
                    session=session,
                    owner_id=message.owner_id,
                    conversation_id=message.conversation_id,
                    source_message_id=message.id,
                    observed_at_utc=datetime.now(UTC),
                ),
            )
            if result.state != "completed":
                message.status = MessageStatus(result.state)
                message.result = result.result
                try:
                    owner = await session.get(User, message.owner_id)
                    message.speech_text = speech_text_for_payload(
                        json.loads(result.result), owner.timezone if owner else "UTC"
                    )
                except (json.JSONDecodeError, TypeError, ValueError, AttributeError):
                    message.speech_text = None
                await session.commit()
                return

            message.status = MessageStatus.completed
            message.result = result.result
            payload = json.loads(result.result)
            owner = await session.get(User, message.owner_id)
            message.speech_text = speech_text_for_payload(
                payload, owner.timezone if owner else "UTC"
            )
            conversation = await session.get(Conversation, message.conversation_id)
            if conversation is not None:
                from sqlalchemy import func

                conversation.last_activity_at = func.now()
            await session.commit()
            try:
                await redis.enqueue_job(
                    "index_owner_calendar",
                    str(message.owner_id),
                    _queue_name="calendar-index",
                )
            except Exception:  # noqa: BLE001 - indexing is repaired by the next search
                logger.warning("Calendar index enqueue failed for owner %s", message.owner_id)
            if payload.get("operations"):
                await schedule_google_sync(message.owner_id, get_settings())
        except Retry:
            raise
        except TranscriptionError as exc:
            logger.exception("Speech transcription failed for message %s", message_id)
            await session.rollback()
            message = await session.get(AgentMessage, ident)
            if message is not None:
                message.status = MessageStatus.failed
                message.error = str(exc)
                message.speech_text = str(exc)
                await session.commit()
        except Exception:
            logger.exception("Agent processing failed for message %s", message_id)
            await session.rollback()
            message = await session.get(AgentMessage, ident)
            if message is not None:
                message.status = MessageStatus.failed
                message.error = "Не удалось обработать сообщение. Попробуйте ещё раз."
                message.speech_text = message.error
                await session.commit()
            raise
        finally:
            await redis.eval(RELEASE_LOCK_SCRIPT, 1, lock_key, token)


class WorkerSettings:
    functions: ClassVar[list] = [process_message]
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
    max_jobs = 10
    max_tries = 8
    job_completion_wait = 300
