import { defineConfig } from "vitest/config";
import path from "node:path";

// Deliberately does not load vite.config.ts: the React and Tailwind plugins are
// irrelevant to these unit tests and only slow the run down.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
