/**
 * One Mongoose connection, cached across Next.js hot reloads and route
 * invocations.
 *
 * If MONGODB_URI is set we use it. If it is not, we start an in-process
 * MongoDB (mongodb-memory-server) so the platform boots with zero setup —
 * the cost is that data resets when the server restarts, which the UI says
 * out loud rather than letting you discover it.
 */
import mongoose from "mongoose";
import { env } from "@/lib/env";

type Cache = {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
  memoryServer: unknown | null;
  uri: string | null;
};

const globalForMongoose = globalThis as unknown as { __vaanijyaMongo?: Cache };

const cache: Cache =
  globalForMongoose.__vaanijyaMongo ??
  (globalForMongoose.__vaanijyaMongo = { conn: null, promise: null, memoryServer: null, uri: null });

async function resolveUri(): Promise<string> {
  if (env.mongo.uri) return env.mongo.uri;
  if (cache.uri) return cache.uri;

  // Dynamic import: a dev-only dependency must never be bundled into a build
  // that runs against a real database.
  const { MongoMemoryServer } = await import("mongodb-memory-server");
  const server = await MongoMemoryServer.create({
    instance: { dbName: env.mongo.dbName },
  });
  cache.memoryServer = server;
  cache.uri = server.getUri(env.mongo.dbName);
  console.log("[db] in-process MongoDB started (set MONGODB_URI to persist data)");
  return cache.uri;
}

export async function connectDb(): Promise<typeof mongoose> {
  if (cache.conn) return cache.conn;

  if (!cache.promise) {
    cache.promise = resolveUri().then((uri) =>
      mongoose.connect(uri, {
        dbName: env.mongo.dbName,
        serverSelectionTimeoutMS: 15000,
        maxPoolSize: 10,
      }),
    );
  }

  try {
    cache.conn = await cache.promise;
  } catch (err) {
    cache.promise = null;
    throw err;
  }
  return cache.conn;
}

export async function disconnectDb(): Promise<void> {
  if (cache.conn) await cache.conn.disconnect();
  if (cache.memoryServer) {
    await (cache.memoryServer as { stop: () => Promise<void> }).stop();
  }
  cache.conn = null;
  cache.promise = null;
  cache.memoryServer = null;
  cache.uri = null;
}
