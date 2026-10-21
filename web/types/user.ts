export type UserPreferences = {
  timezone: string;
  upcoming_days: number;
  open_air_silence_ms: number;
};
export type AuthResponse = { access_token: string };
export type TimezoneResponse = { timezone: string };
