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

test("team CLI reports a missing token before opening the runtime", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/team-memory.mjs", "login"],
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
  assert.match(result.stderr, /TEAM_MEMORY_TOKEN is required/);
  assert.doesNotMatch(result.stderr, /missing bearer token/);
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
