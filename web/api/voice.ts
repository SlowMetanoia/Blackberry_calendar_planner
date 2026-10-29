import type { AgentMessage } from "../types";
import { request, requestResponse } from "./client";

export type VoiceCapabilities = {
  stt: { configured: boolean; sample_rate: number };
  tts: {
    configured: boolean;
    model: string;
    voices: string[];
    sample_rate: number;
  };
};

export const getVoiceCapabilities = () =>
  request<VoiceCapabilities>("/voice/capabilities");

export const createVoiceSessionTicket = () =>
  request<{ ticket: string; expires_in: number }>("/voice/session-tickets", {
    method: "POST",
  });

export function voiceSessionUrl(ticket: string): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/voice/session?ticket=${encodeURIComponent(ticket)}`;
}

export type VoiceServerEvent =
  | {
      type: "state";
      state: "armed" | "ready" | "capturing" | "processing" | "speaking";
      phase?: "wake" | "command";
    }
  | { type: "transcript"; text: string }
  | { type: "message"; message: AgentMessage }
  | { type: "tts_phrase"; index: number; count: number; text: string }
  | { type: "playback_ready" | "playback_skipped" }
  | { type: "tts_unavailable" | "error"; message: string };

export async function getMessageSpeech(
  messageId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await requestResponse(
    `/agent/messages/${encodeURIComponent(messageId)}/speech`,
    { method: "POST", signal },
  );
  return response.blob();
}
