import type { AgentMessage, ConversationSummary, Page } from "../types";
import { request } from "./client";

export const getMessage = (id: string) =>
  request<AgentMessage>(`/agent/messages/${id}`);
export const getConversationHistory = (id: string, limit = 100, offset = 0) =>
  request<Page<AgentMessage>>(
    `/agent/conversations/${id}/messages?limit=${limit}&offset=${offset}`,
  );
export const getConversations = (limit = 100, offset = 0) =>
  request<Page<ConversationSummary>>(
    `/agent/conversations?limit=${limit}&offset=${offset}`,
  );

export const sendMessage = (
  text: string,
  conversationId: string | null = null,
) =>
  request<AgentMessage>("/agent/messages", {
    method: "POST",
    body: JSON.stringify({ text, conversation_id: conversationId }),
  });

export function sendAudioMessage(
  audio: Blob,
  conversationId: string | null = null,
): Promise<AgentMessage> {
  const body = new FormData();
  body.append("audio", audio, "message.webm");
  const suffix = conversationId
    ? `?conversation_id=${encodeURIComponent(conversationId)}`
    : "";
  return request<AgentMessage>(`/agent/messages/audio${suffix}`, {
    method: "POST",
    body,
  });
}
