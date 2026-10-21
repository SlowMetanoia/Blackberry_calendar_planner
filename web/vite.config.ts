import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        rewrite: (p) => p.replace(/^\/api/, ""),
        // The source folder `web/api` is imported as `/api/index.ts` in dev.
        // Let Vite serve those modules instead of forwarding them to FastAPI.
        bypass(req) {
          if (
            req.url &&
            /^\/api\/.*\.(?:ts|tsx|js|jsx|css|map)(?:\?|$)/.test(req.url)
          )
            return req.url;
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./tests/test-setup.ts",
    exclude: ["node_modules/**"],
  },
});
