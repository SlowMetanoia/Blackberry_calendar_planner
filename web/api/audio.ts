import { request } from "./client";

export async function transcribeAudio(audio: Blob): Promise<string> {
  const body = new FormData();
  body.append("audio", audio, "open-air.wav");
  return (
    await request<{ text: string }>("/audio/transcriptions", {
      method: "POST",
      body,
    })
  ).text;
}
