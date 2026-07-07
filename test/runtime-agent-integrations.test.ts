import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ClaudeCodeAgentAdapter,
  CodexAgentAdapter,
  HermesAgentAdapter,
  OpenClawAgentAdapter,
} from "../src/adapters/agent/transports.ts";
import {
  bootstrapDevelopment,
  TeamMemoryRuntime,
} from "../src/adapters/runtime/development-stack.ts";
import { TeamMemoryGateway } from "../src/adapters/runtime/gateway.ts";
import type { Permission } from "../src/contracts/rbac.ts";

const now = "2026-06-30T00:00:00.000Z";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "team-memory-rbac-"));
}

async function setupRuntime() {
  const directory = await temporaryDirectory();
  const runtime = await TeamMemoryRuntime.create({
    libsqlUrl: `file:${join(directory, "runtime-agents.db")}`,
    casDirectory: join(directory, "cas"),
    qdrantUrl: "http://127.0.0.1:6333",
    objectStoreUrl: "http://127.0.0.1:9000",
  });
  const admin = await bootstrapDevelopment(runtime, {
    rootEntityId: "root-runtime",
    userId: "user-runtime",
    displayName: "Runtime User",
    sessionId: "session-runtime-admin",
    sessionExpiresAt: "2030-01-01T00:00:00.000Z",
    now,
  });
  return { directory, runtime, admin };
}

const readPermissions: Permission[] = [
  { action: "read", resourceKind: "memory_entity" },
  { action: "search", resourceKind: "memory_entity" },
];

const writePermissions: Permission[] = [
  ...readPermissions,
  { action: "write_entity", resourceKind: "memory_entity" },
  { action: "write_entity_branch", resourceKind: "memory_entity_branch" },
];

test("OpenClaw, Claude Code, Codex, and Hermes use real sessions for read, search, and write", async () => {
  const { directory, runtime } = await setupRuntime();
  try {
    await runtime.rbac.saveAgent({
      id: "agent-write-runtime",
      ownerUserId: "user-runtime",
      agentType: "curator_agent",
      displayName: "Runtime Writer",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await runtime.rbac.saveDelegation({
      id: "delegation-write-runtime",
      agentId: "agent-write-runtime",
      ownerUserId: "user-runtime",
      rootEntityId: "root-runtime",
      permissions: writePermissions,
      delegatedBy: "user-runtime",
      delegatedAt: now,
      status: "active",
    });
    const session = await runtime.rbac.createSession({
      id: "session-write-runtime",
      userId: "user-runtime",
      agentId: "agent-write-runtime",
      delegationId: "delegation-write-runtime",
      rootEntityId: "root-runtime",
      taskScope: { rootEntityId: "root-runtime" },
      expiresAt: "2030-01-01T00:00:00.000Z",
      createdAt: now,
    });
    const gateway = new TeamMemoryGateway(runtime);
    const adapters = [
      new OpenClawAgentAdapter(gateway),
      new ClaudeCodeAgentAdapter(gateway),
      new CodexAgentAdapter(gateway),
      new HermesAgentAdapter(gateway),
    ];

    for (const [index, adapter] of adapters.entries()) {
      assert.equal(
        (await adapter.resolvePrincipal(session.token)).rootEntityId,
        "root-runtime",
      );
      const tools = await adapter.listTools(session.token);
      assert.ok(tools.some((tool) => tool.name === "memory.write"));
      await adapter.invokeTool(session.token, "memory.write", {
        clientMutationId: `runtime-write-entity-${index}`,
        action: "write_entity",
        resourceKind: "memory_entity",
        commit: { id: `commit-runtime-entity-${index}` },
        operation: {
          kind: "create_entity",
          id: `operation-runtime-entity-${index}`,
          entity: {
            id: `entity-runtime-${index}`,
            rootEntityId: "root-runtime",
            currentBranchId: `branch-runtime-${index}`,
            status: "active",
            createdAt: now,
            updatedAt: now,
          },
        },
      });
      await adapter.invokeTool(session.token, "memory.write", {
        clientMutationId: `runtime-write-branch-${index}`,
        action: "write_entity_branch",
        resourceKind: "memory_entity_branch",
        commit: { id: `commit-runtime-branch-${index}` },
        operation: {
          kind: "create_entity_branch",
          id: `operation-runtime-branch-${index}`,
          branch: {
            id: `branch-runtime-${index}`,
            entityId: `entity-runtime-${index}`,
            rootEntityId: "root-runtime",
            branchRef: "main",
            title: `Runtime Note ${index}`,
            tags: ["runtime"],
            status: "active",
            createdAt: now,
            updatedAt: now,
          },
        },
      });
      const result = await adapter.invokeTool(session.token, "memory.search", {
        query: { kind: "entity", text: `Runtime Note ${index}` },
      }) as { value: { items: unknown[] } };
      assert.equal(result.value.items.length, 1);
    }
  } finally {
    runtime.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test("read-only runtime agents cannot see or bypass write tools, and revoked delegations fail live", async () => {
  const { directory, runtime } = await setupRuntime();
  try {
    await runtime.rbac.saveAgent({
      id: "agent-read-runtime",
      ownerUserId: "user-runtime",
      agentType: "sub_agent",
      displayName: "Runtime Reader",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await runtime.rbac.saveDelegation({
      id: "delegation-read-runtime",
      agentId: "agent-read-runtime",
      ownerUserId: "user-runtime",
      rootEntityId: "root-runtime",
      permissions: readPermissions,
      delegatedBy: "user-runtime",
      delegatedAt: now,
      status: "active",
    });
    const session = await runtime.rbac.createSession({
      id: "session-read-runtime",
      userId: "user-runtime",
      agentId: "agent-read-runtime",
      delegationId: "delegation-read-runtime",
      rootEntityId: "root-runtime",
      taskScope: { rootEntityId: "root-runtime" },
      expiresAt: "2030-01-01T00:00:00.000Z",
      createdAt: now,
    });
    const adapter = new CodexAgentAdapter(new TeamMemoryGateway(runtime));
    assert.equal(
      (await adapter.listTools(session.token)).some((tool) => tool.name === "memory.write"),
      false,
    );
    const denied = await adapter.invokeTool(session.token, "memory.write", {
      clientMutationId: "runtime-denied",
      action: "write_entity",
      resourceKind: "memory_entity",
      commit: { id: "commit-runtime-denied" },
      operation: {
        kind: "create_entity",
        id: "operation-runtime-denied",
        entity: {
          id: "entity-runtime-denied",
          rootEntityId: "root-runtime",
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      },
    });
    assert.equal(denied.decision.allowed, false);
    await runtime.rbac.revokeDelegation("delegation-read-runtime", now);
    await assert.rejects(
      () => adapter.resolvePrincipal(session.token),
      /invalid session/,
    );
  } finally {
    runtime.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
