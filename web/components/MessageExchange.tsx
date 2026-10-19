import { formatMessageTimestamp } from "../libs/format";
import type { AgentMessage } from "../types";
import { OperationReceipt } from "./OperationReceipt";
import { ReadCard } from "./ReadCard";

const pending = new Set(["queued", "transcribing", "processing"]);

function MessageTime({
  value,
  className = "",
}: {
  value: string;
  className?: string;
}) {
  const label = formatMessageTimestamp(value);
  return label ? (
    <time className={`message-time ${className}`} dateTime={value}>
      {label}
    </time>
  ) : null;
}

export function MessageExchange({
  message,
  startNewConversation,
}: {
  message: AgentMessage;
  startNewConversation: () => void;
}) {
  const transcribing = !message.input_text && pending.has(message.status);
  const showBot = Boolean(
    message.input_text ||
      message.reply ||
      message.display_items.length ||
      message.operations.length ||
      message.error ||
      message.requires_new_conversation,
  );
  return (
    <article className="exchange">
      {message.input_text && (
        <div className="bubble user">
          <div>{message.input_text}</div>
          <MessageTime value={message.created_at} />
        </div>
      )}
      {transcribing && (
        <div className="transcription-status">
          <span>●</span> Распознаю…
        </div>
      )}
      {showBot && (
        <div className="bubble bot">
          <div className="bot-mark">✦</div>
          <div className="bot-content">
            {message.reply ? (
              <p>{message.reply}</p>
            ) : message.input_text && pending.has(message.status) ? (
              <p className="muted">Думаю…</p>
            ) : null}
            {message.display_items.map((item) => (
              <ReadCard read={item} key={`${item.resource}-${item.id}`} />
            ))}
            {message.operations.map((item) => (
              <OperationReceipt item={item} key={item.id} />
            ))}
            {message.requires_new_conversation && (
              <button
                className="primary new-conversation"
                onClick={startNewConversation}
              >
                Начать новый диалог
              </button>
            )}
            {message.error && <p className="error">{message.error}</p>}
            <MessageTime value={message.created_at} className="bot-time" />
          </div>
        </div>
      )}
    </article>
  );
}
