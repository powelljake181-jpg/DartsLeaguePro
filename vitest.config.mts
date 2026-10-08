import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // PGlite instances are memory-hungry; keep DB test files from running all at once.
    maxWorkers: 2,
    testTimeout: 30_000,
    // Each beforeEach builds a fresh PGlite database; give it the same budget as a test.
    hookTimeout: 30_000,
  },
});
