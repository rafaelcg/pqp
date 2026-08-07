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
    // `.tsx` too, so a component whose whole job is rendering one string can be
    // pinned. These render through `react-dom/server`, which needs no DOM — the
    // environment stays `node` and the suite keeps costing nothing.
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
