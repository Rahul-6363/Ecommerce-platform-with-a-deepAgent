/**
 * Test environment setup.
 *
 * Two jobs, and the second one matters more than the first.
 *
 * 1. Load .env, because Next.js does that automatically and Vitest does not.
 *    Without it the live-model tests skip themselves even when a key is
 *    configured, hiding the exact failure they exist to catch.
 *
 * 2. **Refuse to use a real database.** Every suite here calls `seed()`, which
 *    deletes every collection before rebuilding. If MONGODB_URI points at a
 *    real cluster, running the tests destroys that data. So the URI is dropped
 *    unconditionally and each test file gets its own in-process MongoDB —
 *    which also stops the files colliding with each other when Vitest runs
 *    them in parallel.
 */
import { readFileSync } from "node:fs";

for (const file of [".env", ".env.local"]) {
  try {
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i < 1) continue;
      const key = line.slice(0, i).trim();
      let value = line.slice(i + 1).trim();
      if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
        value = value.slice(1, -1);
      }
      // A real environment variable always wins over the file.
      if (!process.env[key] && value) process.env[key] = value;
    }
  } catch {
    /* the file is optional */
  }
}

// Never, under any configuration, let the suite seed over a real database.
if (process.env.MONGODB_URI) {
  console.warn(
    "[tests] ignoring MONGODB_URI — the suite seeds destructively and runs " +
      "against an in-process MongoDB instead.",
  );
  delete process.env.MONGODB_URI;
}
// A distinct database name per worker, so parallel files cannot collide.
process.env.MONGODB_DB = `vaanijya_test_${process.pid}`;
