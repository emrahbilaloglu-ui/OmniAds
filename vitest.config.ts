import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./vitest.setup.dom.ts"],
    // Vitest's 5s default was never a deliberate bound for this suite. Several
    // tests legitimately take seconds — hashing the whole repository, walking
    // every module for import guards, driving multi-page UI flows through
    // jsdom — and they had drifted close enough to 5s to time out
    // intermittently under load. A timeout is a liveness bound, not an
    // assertion: nothing here is relaxed, and 15s is still short enough that a
    // genuine hang fails fast.
    testTimeout: 15_000,
    exclude: ["node_modules/**", "dist/**", ".next/**", ".claude/**", "playwright/**", "lib/archive/v1-v2-v21/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
