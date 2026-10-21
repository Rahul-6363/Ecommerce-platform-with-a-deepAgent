import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 20000,
    // One file at a time. The live-model tests share a tokens-per-minute
    // budget on Groq's free tier, and running files in parallel makes them
    // compete for it — a 429 then looks like a product failure. Each file also
    // seeds its own database, so serial execution removes that collision too.
    fileParallelism: false,
  },
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
});
