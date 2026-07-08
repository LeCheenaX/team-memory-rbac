import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  TeamManagementCli,
  parseTeamManagementCommand,
} from "../src/adapters/cli/team-management.ts";
import {
  bootstrapDevelopment,
  TeamMemoryRuntime,
} from "../src/adapters/runtime/development-stack.ts";
import { TeamMemoryGateway } from "../src/adapters/runtime/gateway.ts";

const now = "2026-06-30T00:00:00.000Z";

test("team CLI reports a missing login before opening the runtime", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/team-memory.mjs", "roots", "list"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEAM_MEMORY_TOKEN: "",
        ADMIN_TOKEN: "",
        LIBSQL_URL: "",
        CAS_BACKEND: "",
        CAS_DIRECTORY: "",
        QDRANT_URL: "",
      },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Team Memory is not logged in/);
  assert.doesNotMatch(result.stderr, /missing bearer token/);
});

test("team CLI falls back to ADMIN_TOKEN when TEAM_MEMORY_TOKEN is empty", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/team-memory.mjs", "login"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEAM_MEMORY_TOKEN: "",
        ADMIN_TOKEN: "admin-token-from-compose-run",
        LIBSQL_URL: "",
        CAS_BACKEND: "",
        CAS_DIRECTORY: "",
        QDRANT_URL: "",
      },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /Team Memory is not logged in/);
});

test("team management CLI routes identity, RBAC, delegation, conflict, sync, and health commands through the gateway", async () => {
  const directory = await mkdtemp(join(tmpdir(), "team-memory-rbac-"));
  const runtime = await TeamMemoryRuntime.create({
    libsqlUrl: `file:${join(directory, "team-cli.db")}`,
    casDirectory: join(directory, "cas"),
    qdrantUrl: "http://127.0.0.1:6333",
    objectStoreUrl: "http://127.0.0.1:9000",
  });
  try {
    const session = await bootstrapDevelopment(runtime, {
      rootEntityId: "root-cli",
      userId: "user-admin-cli",
      displayName: "CLI Admin",
      sessionId: "session-cli-admin",
      sessionExpiresAt: "2030-01-01T00:00:00.000Z",
      now,
    });
    await runtime.rbac.saveUser({
      id: "user-member-cli",
      displayName: "CLI Member",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await runtime.rbac.saveAgent({
      id: "agent-cli",
      ownerUserId: "user-admin-cli",
      agentType: "sub_agent",
      displayName: "CLI Agent",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const cli = new TeamManagementCli(new TeamMemoryGateway(runtime));
    assert.equal(
      ((await cli.run(session.token, ["login"])) as { userId: string }).userId,
      "user-admin-cli",
    );
    assert.deepEqual(
      await cli.run(session.token, parseTeamManagementCommand(["roots", "list"])),
      { roots: ["root-cli"] },
    );
    await cli.run(session.token, [
      "members",
      "assign",
      "assignment-cli-member",
      "user-member-cli",
      "role-researcher",
    ]);
    assert.equal(
      ((await cli.run(session.token, ["members", "list"])) as { assignments: unknown[] }).assignments.length,
      2,
    );
    await cli.run(session.token, [
      "delegations",
      "create",
      "delegation-cli",
      "agent-cli",
      JSON.stringify([
        {
          action: "read",
          resourceKind: "memory_entity",
          constraints: { allowRootEntityMutation: true },
        },
      ]),
    ]);
    assert.equal(
      ((await cli.run(session.token, ["delegations", "list"])) as { delegations: unknown[] }).delegations.length,
      1,
    );
    await cli.run(
      session.token,
      parseTeamManagementCommand([
        "agents",
        "onboard",
        "agent-cli-readonly",
        "delegation-cli-readonly",
        "session-cli-readonly",
        "2030-01-01T00:00:00.000Z",
        "read-only",
      ]),
    );
    assert.equal(
      ((await cli.run(session.token, ["delegations", "list"])) as { delegations: unknown[] }).delegations.length,
      2,
    );
    assert.deepEqual(await cli.run(session.token, ["conflicts", "list"]), {
      conflicts: [],
    });
    assert.equal(
      ((await cli.run(session.token, ["sync", "status"])) as { rootEntityId: string }).rootEntityId,
      "root-cli",
    );
    assert.equal(
      ((await cli.run(session.token, ["replica", "status"])) as { rootEntityId: string }).rootEntityId,
      "root-cli",
    );
    await new TeamMemoryGateway(runtime).importResource(session.token, {
      clientMutationId: "cli-import-resource",
      resourceId: "resource-cli",
      title: "CLI resource",
      sourceType: "document",
      content: "CLI ingestion creates searchable chunks.",
    });
    const ingestion = await cli.run(
      session.token,
      parseTeamManagementCommand(["resources", "ingest", "resource-cli"]),
    ) as { chunks: unknown[]; rebuiltOnly: boolean };
    assert.equal(ingestion.chunks.length, 1);
    assert.equal(ingestion.rebuiltOnly, false);
    assert.equal(
      ((await cli.run(session.token, ["health"])) as { live: boolean }).live,
      true,
    );
    await cli.run(session.token, ["delegations", "revoke", "delegation-cli", "agent-cli"]);
    await cli.run(session.token, ["members", "revoke", "assignment-cli-member", "user-member-cli"]);
  } finally {
    runtime.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("team CLI login stores the active session and logout clears it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "team-memory-rbac-"));
  const config = {
    libsqlUrl: `file:${join(directory, "team-cli-login.db")}`,
    casDirectory: join(directory, "cas"),
    qdrantUrl: "http://127.0.0.1:6333",
    objectStoreUrl: "http://127.0.0.1:9000",
  };
  const runtime = await TeamMemoryRuntime.create(config);
  try {
    await bootstrapDevelopment(runtime, {
      rootEntityId: "root-cli-login",
      userId: "user-cli-login",
      displayName: "CLI Login",
      sessionId: "session-cli-login-bootstrap",
      sessionExpiresAt: "2030-01-01T00:00:00.000Z",
      now,
    });
    await runtime.rbac.setUserPassword({
      userId: "user-cli-login",
      password: "correct horse battery staple",
      now,
    });
  } finally {
    runtime.close();
  }

  const env = {
    ...process.env,
    TEAM_MEMORY_TOKEN: "",
    ADMIN_TOKEN: "",
    TEAM_MEMORY_SESSION_FILE: join(directory, "session.json"),
    TEAM_MEMORY_ROOT_ENTITY_ID: "root-cli-login",
    TEAM_MEMORY_SESSION_EXPIRES_AT: "2030-01-01T00:00:00.000Z",
    LIBSQL_URL: config.libsqlUrl,
    CAS_BACKEND: "filesystem",
    CAS_DIRECTORY: config.casDirectory,
    QDRANT_URL: config.qdrantUrl,
  };
  try {
    const login = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/team-memory.mjs", "login", "user-cli-login", "correct horse battery staple"],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
    assert.equal(login.status, 0, login.stderr);
    assert.match(login.stdout, /"status": "logged_in"/);
    assert.doesNotMatch(login.stdout, /sessionToken/);

    const roots = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/team-memory.mjs", "roots", "list"],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
    assert.equal(roots.status, 0, roots.stderr);
    assert.match(roots.stdout, /root-cli-login/);

    const createReader = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "scripts/team-memory.mjs",
        "members",
        "create",
        "user-cli-reader",
        "Reader",
        "reader password",
        "role-researcher",
      ],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
    assert.equal(createReader.status, 0, createReader.stderr);
    assert.match(createReader.stdout, /user-cli-reader/);

    const logout = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/team-memory.mjs", "logout"],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
    assert.equal(logout.status, 0, logout.stderr);
    assert.match(logout.stdout, /"status": "logged_out"/);

    const afterLogout = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/team-memory.mjs", "roots", "list"],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
    assert.equal(afterLogout.status, 1);
    assert.match(afterLogout.stderr, /Team Memory is not logged in/);

    const readerLogin = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/team-memory.mjs", "login", "user-cli-reader", "reader password"],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
    assert.equal(readerLogin.status, 0, readerLogin.stderr);
    assert.match(readerLogin.stdout, /user-cli-reader/);

    const readerRoots = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/team-memory.mjs", "roots", "list"],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
    assert.equal(readerRoots.status, 0, readerRoots.stderr);
    assert.match(readerRoots.stdout, /root-cli-login/);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
