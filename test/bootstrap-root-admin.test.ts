import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TeamMemoryRuntime } from "../src/adapters/runtime/development-stack.ts";

function runBootstrap(directory: string, password?: string) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/bootstrap-root-admin.mjs"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LIBSQL_URL: `file:${join(directory, "team-memory.db")}`,
        CAS_BACKEND: "filesystem",
        CAS_DIRECTORY: join(directory, "cas"),
        QDRANT_URL: "http://127.0.0.1:6333",
        BOOTSTRAP_ROOT_ENTITY_ID: "root:test-bootstrap",
        BOOTSTRAP_USER_ID: "user:test-bootstrap-admin",
        BOOTSTRAP_USER_NAME: "Bootstrap Admin",
        BOOTSTRAP_SESSION_ID: "session:test-bootstrap-admin",
        BOOTSTRAP_SESSION_EXPIRES_AT: "2030-01-01T00:00:00.000Z",
        BOOTSTRAP_NOW: "2026-07-08T00:00:00.000Z",
        BOOTSTRAP_USER_PASSWORD: password ?? "",
        TEAM_MEMORY_SESSION_FILE: join(directory, "active-session.json"),
      },
      encoding: "utf8",
    },
  );
}

test("root admin bootstrap can reissue the same session with a password", async () => {
  const directory = await mkdtemp(join(tmpdir(), "team-memory-bootstrap-"));
  try {
    const first = runBootstrap(directory, "correct horse battery staple");
    assert.equal(first.status, 0, first.stderr);
    const firstPayload = JSON.parse(first.stdout) as {
      sessionId: string;
      sessionFile: string;
    };
    const firstStored = JSON.parse(await readFile(firstPayload.sessionFile, "utf8")) as {
      sessionToken: string;
    };

    const second = runBootstrap(directory, "correct horse battery staple");
    assert.equal(second.status, 0, second.stderr);
    const secondPayload = JSON.parse(second.stdout) as {
      sessionId: string;
      sessionFile: string;
    };
    const secondStored = JSON.parse(await readFile(secondPayload.sessionFile, "utf8")) as {
      sessionToken: string;
    };

    assert.equal(secondPayload.sessionId, firstPayload.sessionId);
    assert.equal(secondPayload.sessionFile, firstPayload.sessionFile);
    assert.notEqual(secondStored.sessionToken, firstStored.sessionToken);

    const runtime = await TeamMemoryRuntime.create({
      libsqlUrl: `file:${join(directory, "team-memory.db")}`,
      casDirectory: join(directory, "cas"),
      qdrantUrl: "http://127.0.0.1:6333",
    });
    try {
      assert.equal(await runtime.rbac.authenticate(firstStored.sessionToken), undefined);
      assert.equal((await runtime.rbac.authenticate(secondStored.sessionToken))?.sessionId, secondPayload.sessionId);
    } finally {
      runtime.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("root admin bootstrap explains repeated one-shot token creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "team-memory-bootstrap-"));
  try {
    const first = runBootstrap(directory);
    assert.equal(first.status, 0, first.stderr);

    const second = runBootstrap(directory);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /root admin session already exists/);
    assert.doesNotMatch(second.stderr, /UNIQUE constraint failed/);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
