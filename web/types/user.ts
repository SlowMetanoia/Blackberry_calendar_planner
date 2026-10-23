export type UserPreferences = {
  timezone: string;
  upcoming_days: number;
  open_air_silence_ms: number;
  open_air_active_timeout_seconds?: number;
  voice_output_enabled?: boolean;
  tts_voice?: "aidar" | "baya" | "kseniya" | "xenia" | "eugene";
  tts_speed?: number;
  open_air_default?: boolean;
  mascot_visible?: boolean;
};
export type AuthResponse = { access_token: string };
export type TimezoneResponse = { timezone: string };
