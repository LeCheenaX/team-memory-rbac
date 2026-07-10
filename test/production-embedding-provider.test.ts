import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadRuntimeConfig,
  TeamMemoryRuntime,
} from "../src/adapters/runtime/development-stack.ts";
import type { EmbeddingProvider } from "../src/index.ts";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "team-memory-rbac-"));
}

test("production runtime rejects deterministic or missing embedding providers", async () => {
  assert.throws(
    () =>
      loadRuntimeConfig({
        TEAM_MEMORY_RUNTIME_MODE: "production",
        LIBSQL_URL: "file:prod.db",
        CAS_BACKEND: "filesystem",
        CAS_DIRECTORY: "/var/cas",
        QDRANT_URL: "http://qdrant",
      }),
    /EMBEDDING_PROVIDER/,
  );
  assert.throws(
    () =>
      loadRuntimeConfig({
        TEAM_MEMORY_RUNTIME_MODE: "production",
        EMBEDDING_PROVIDER: "deterministic",
        LIBSQL_URL: "file:prod.db",
        CAS_BACKEND: "filesystem",
        CAS_DIRECTORY: "/var/cas",
        QDRANT_URL: "http://qdrant",
      }),
    /deterministic embeddings are not allowed in production/,
  );
  await assert.rejects(
    () =>
      TeamMemoryRuntime.create({
        runtimeMode: "production",
        libsqlUrl: "file:prod-without-embeddings.db",
        casBackend: "filesystem",
        casDirectory: "/var/cas",
        qdrantUrl: "http://qdrant",
      }),
    /production embedding provider must be configured/,
  );
});

test("production runtime starts with a configured provider seam", async () => {
  const directory = await temporaryDirectory();
  const embeddings: EmbeddingProvider = {
    name: "test-production-embeddings",
    productionSafe: true,
    embed: async () => [1, 0, 0],
  };
  const runtime = await TeamMemoryRuntime.create({
    runtimeMode: "production",
    libsqlUrl: `file:${join(directory, "production-embeddings.db")}`,
    casBackend: "filesystem",
    casDirectory: join(directory, "cas"),
    qdrantUrl: "http://127.0.0.1:6333",
    embeddings,
  });
  try {
    assert.ok(runtime);
  } finally {
    runtime.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  }
});
