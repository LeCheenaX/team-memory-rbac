import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createClient } from "@libsql/client";
import {
  clearTestMemory,
  type TestMemoryMaintenanceConfig,
} from "../src/adapters/runtime/test-memory-maintenance.ts";

function powershell(script: string, ...args: string[]) {
  return spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
    { encoding: "utf8" },
  );
}

test("redeploy CLI replaces all Hermes test images while preserving volumes", () => {
  const result = powershell("scripts/redeploy-hermes-tests.ps1", "-DryRun");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /build --pull service hermes-local hermes-a hermes-b/);
  assert.match(result.stdout, /up -d --force-recreate libsql qdrant object-store service/);
  assert.match(result.stdout, /exec -T service sh -lc/);
  for (const service of ["hermes-local", "hermes-a", "hermes-b"]) {
    assert.match(result.stdout, new RegExp(`run --rm --no-deps ${service} sh -lc`));
  }
  assert.match(result.stdout, /HermesTeamMemoryProvider/);
  assert.doesNotMatch(result.stdout, /--volumes|\bdown\b/);
});

test("redeploy CLI supports a cache-free rebuild", () => {
  const result = powershell("scripts/redeploy-hermes-tests.ps1", "-DryRun", "-NoCache");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /build --pull --no-cache service hermes-local hermes-a hermes-b/);
});

test("memory maintenance clears non-core stores but preserves RBAC", async () => {
  const directory = await mkdtemp(join(tmpdir(), "team-memory-reset-"));
  const databasePath = join(directory, "memory.db");
  const casPath = join(directory, "cas");
  const client = createClient({ url: `file:${databasePath}` });
  const requests: Array<{ method?: string; url?: string }> = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const config: TestMemoryMaintenanceConfig = {
    runtimeMode: "Dev",
    libsql: { url: `file:${databasePath}` },
    qdrant: { url: `http://127.0.0.1:${(address as { port: number }).port}` },
    cas: { backend: "filesystem", directory: casPath },
  };

  try {
    await client.batch([
      "create table rbac_users(user_id text primary key, payload_json text not null)",
      "create table history_request_journal(sequence integer primary key, request_json text)",
      "create table memory_relations(id text primary key)",
      "create table bm25_documents(id text primary key)",
      "insert into rbac_users values ('user:admin', '{}')",
      "insert into history_request_journal values (1, '{}')",
      "insert into memory_relations values ('relation:1')",
      "insert into bm25_documents values ('document:1')",
    ]);
    await mkdir(casPath, { recursive: true });
    await writeFile(join(casPath, "blob"), "memory bytes");

    const result = await clearTestMemory(config);
    assert.equal(result.preserved, "rbac_*");
    assert.equal(result.filesystemCasCleared, true);

    const users = await client.execute("select user_id from rbac_users");
    const history = await client.execute("select * from history_request_journal");
    const relations = await client.execute("select * from memory_relations");
    const bm25 = await client.execute("select * from bm25_documents");
    assert.deepEqual(users.rows.map((row) => row.user_id), ["user:admin"]);
    assert.equal(history.rows.length, 0);
    assert.equal(relations.rows.length, 0);
    assert.equal(bm25.rows.length, 0);
    await assert.rejects(readFile(join(casPath, "blob")));
    assert.deepEqual(
      requests.map(({ method, url }) => `${method} ${url}`),
      [
        "DELETE /collections/memory_entities",
        "DELETE /collections/memory_entity_branches",
        "DELETE /collections/resource_chunks",
      ],
    );

    const objectStoreDirectory = join(directory, "object-store");
    await mkdir(objectStoreDirectory, { recursive: true });
    await writeFile(join(objectStoreDirectory, "immutable-memory"), "bytes");
    const objectStoreResult = await clearTestMemory(
      { ...config, cas: { backend: "object_store" } },
      { skipVectors: true, objectStoreCasDirectory: objectStoreDirectory },
    );
    assert.equal(objectStoreResult.objectStoreCasCleared, true);
    await assert.rejects(readFile(join(objectStoreDirectory, "immutable-memory")));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
    client.close();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
});

test("memory maintenance rejects production and remote persistence", async () => {
  await assert.rejects(
    clearTestMemory({
      runtimeMode: "Production",
      libsql: { url: "https://database.example.com" },
      qdrant: { url: "https://vectors.example.com" },
      cas: { backend: "object_store" },
    }),
    /runtimeMode must be Dev/,
  );
});

test("clear CLI targets local and shared stores through the core maintenance module", () => {
  const result = powershell("scripts/clear-hermes-test-memories.ps1", "-DryRun");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /hermes-local.*clear-test-memory\.mjs/);
  assert.match(result.stdout, /memory-test-maintenance.*clear-test-memory\.mjs/);
  assert.match(result.stdout, /--experimental-strip-types/);
  assert.match(result.stdout, /--object-store-cas-directory \/test-object-store/);
  assert.doesNotMatch(result.stdout, /--volumes|\bdown\b|rm -rf|find \/data|libsql-data|hermes-local-home/);
});

