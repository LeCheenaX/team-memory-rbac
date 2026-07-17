import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createClient } from "@libsql/client";

function powershell(script: string, ...args: string[]) {
  return spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
    { encoding: "utf8" },
  );
}

function runNode(...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("redeploy CLI requires one explicit Hermes target", () => {
  const result = powershell("scripts/redeploy-hermes-tests.ps1", "-DryRun");
  assert.notEqual(result.status, 0);
});

test("redeploy CLI rebuilds only hermes-local", () => {
  const result = powershell("scripts/redeploy-hermes-tests.ps1", "-Target", "hermes-local", "-DryRun");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rm -sf hermes-local/);
  assert.match(result.stdout, /build --pull hermes-local/);
  assert.match(result.stdout, /run --rm --no-deps hermes-local sh -lc/);
  assert.doesNotMatch(result.stdout, /hermes-a|hermes-b|\bup -d\b|--volumes|\bdown\b/);
});

test("redeploy CLI rebuilds only hermes-a and its shared service image", () => {
  const result = powershell("scripts/redeploy-hermes-tests.ps1", "-Target", "hermes-a", "-DryRun");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rm -sf hermes-a/);
  assert.match(result.stdout, /build --pull service hermes-a/);
  assert.match(result.stdout, /run --rm --no-deps service sh -lc/);
  assert.match(result.stdout, /run --rm --no-deps hermes-a sh -lc/);
  assert.doesNotMatch(result.stdout, /hermes-local|hermes-b|\bup -d\b/);
});

test("redeploy CLI supports a cache-free targeted rebuild", () => {
  const result = powershell("scripts/redeploy-hermes-tests.ps1", "-Target", "hermes-b", "-DryRun", "-NoCache");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /build --pull --no-cache service hermes-b/);
  assert.doesNotMatch(result.stdout, /hermes-local|hermes-a/);
});

test("memory reset deletes memory stores but preserves RBAC tables", async () => {
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
  const qdrantUrl = `http://127.0.0.1:${(address as { port: number }).port}`;
  const configPath = join(directory, "config.json");

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
    await writeFile(configPath, JSON.stringify({
      runtimeMode: "Dev",
      libsql: { url: `file:${databasePath}` },
      qdrant: { url: qdrantUrl },
      cas: { backend: "filesystem", directory: casPath },
    }));

    const result = await runNode("scripts/clear-test-memory.mjs", "--config", configPath);
    assert.equal(result.status, 0, result.stderr);

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
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("clear CLI requires one explicit Hermes target", () => {
  const result = powershell("scripts/clear-hermes-test-memories.ps1", "-DryRun");
  assert.notEqual(result.status, 0);
});

test("clear CLI clears only hermes-local memory", () => {
  const result = powershell("scripts/clear-hermes-test-memories.ps1", "-Target", "hermes-local", "-DryRun");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /build hermes-local/);
  assert.match(result.stdout, /rm -sf hermes-local/);
  assert.match(result.stdout, /up -d qdrant/);
  assert.match(result.stdout, /hermes-local.*clear-test-memory\.mjs/);
  assert.doesNotMatch(result.stdout, /hermes-a|hermes-b|\bservice\b|object-store|libsql/);
});

test("clear CLI clears shared server memory for only the selected Hermes client", () => {
  const result = powershell("scripts/clear-hermes-test-memories.ps1", "-Target", "hermes-b", "-DryRun");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /build service/);
  assert.match(result.stdout, /rm -sf hermes-b/);
  assert.match(result.stdout, /stop service object-store/);
  assert.match(result.stdout, /up -d libsql qdrant/);
  assert.match(result.stdout, /service.*clear-test-memory\.mjs/);
  assert.match(result.stdout, /test .*resolved.*\/data/);
  assert.doesNotMatch(result.stdout, /hermes-local|hermes-a|up -d --force-recreate/);
});

