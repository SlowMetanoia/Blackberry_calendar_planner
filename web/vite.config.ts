import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": { target: "http://localhost:8000", rewrite: p => p.replace(/^\/api/, "") } } },
  test: { environment: "jsdom", setupFiles: "./src/test-setup.ts", exclude: ["e2e/**", "node_modules/**"] }
});
