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
import { unitTestRuntimeConfig } from "./support/runtime-config.ts";

const now = "2026-06-30T00:00:00.000Z";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "team-memory-rbac-"));
}

async function setupRuntime(suffix: string) {
  const directory = await temporaryDirectory();
  const rootEntityId = `root-runtime-${suffix}`;
  const userId = `user-runtime-${suffix}`;
  const runtime = await TeamMemoryRuntime.create(unitTestRuntimeConfig({
    directory,
    databaseName: "runtime-agents.db",
  }));
  const admin = await bootstrapDevelopment(runtime, {
    rootEntityId,
    userId,
    displayName: "Runtime User",
    sessionId: `session-runtime-admin-${suffix}`,
    sessionExpiresAt: "2030-01-01T00:00:00.000Z",
    now,
  });
  return { directory, runtime, admin, rootEntityId, userId };
}

const readPermissions: Permission[] = [
  { action: "read", resourceKind: "memory_entity" },
  { action: "search", resourceKind: "memory_entity" },
];

const writePermissions: Permission[] = [
  ...readPermissions,
  { action: "write_entity", resourceKind: "memory_entity" },
  { action: "write_entity_branch", resourceKind: "memory_entity_branch" },
  { action: "commit", resourceKind: "memory_entity" },
];

test("runtime adapters use stable tools and enforce live read-only delegation", async () => {
    const { directory, runtime, rootEntityId, userId } = await setupRuntime("write");
    try {
      await runtime.rbac.saveAgent({
        id: "agent-write-runtime",
        ownerUserId: userId,
        agentType: "curator_agent",
        displayName: "Runtime Writer",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await runtime.rbac.saveDelegation({
        id: "delegation-write-runtime",
        agentId: "agent-write-runtime",
        ownerUserId: userId,
        rootEntityId,
        permissions: writePermissions,
        delegatedBy: userId,
        delegatedAt: now,
        status: "active",
      });
      const session = await runtime.rbac.createSession({
        id: "session-write-runtime",
        userId,
        agentId: "agent-write-runtime",
        delegationId: "delegation-write-runtime",
        rootEntityId,
        taskScope: { rootEntityId },
        expiresAt: "2030-01-01T00:00:00.000Z",
        createdAt: now,
      });
      const gateway = new TeamMemoryGateway(runtime, {
        retrieval: "active-view",
        projectWrites: false,
      });
      const adapters = [
        new OpenClawAgentAdapter(gateway),
        new ClaudeCodeAgentAdapter(gateway),
        new CodexAgentAdapter(gateway),
        new HermesAgentAdapter(gateway),
      ];

      for (const [index, adapter] of adapters.entries()) {
        assert.equal(
          (await adapter.resolvePrincipal(session.token)).rootEntityId,
          rootEntityId,
        );
        const tools = await adapter.listTools(session.token);
        assert.ok(tools.some((tool) => tool.name === "memory.write"));
        await adapter.invokeTool(session.token, "memory.write", {
          clientMutationId: `runtime-write-${index}`,
          target: {
            kind: "memory_entity",
            name: `Runtime Note ${index}`,
          },
          patch: {
            title: `Runtime Note ${index}`,
            description: "Runtime adapters write through stable capture.",
            tags: ["runtime"],
          },
        });
        const result = await adapter.invokeTool(session.token, "memory.search", {
          query: `Runtime Note ${index}`,
          names: [`Runtime Note ${index}`],
          tagsAny: ["runtime"],
        }) as { value: { items: unknown[] } };
        assert.equal(result.value.items.length, 1);
      }
      await runtime.rbac.saveAgent({
        id: "agent-read-runtime",
        ownerUserId: userId,
        agentType: "sub_agent",
        displayName: "Runtime Reader",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await runtime.rbac.saveDelegation({
        id: "delegation-read-runtime",
        agentId: "agent-read-runtime",
        ownerUserId: userId,
        rootEntityId,
        permissions: readPermissions,
        delegatedBy: userId,
        delegatedAt: now,
        status: "active",
      });
      const readSession = await runtime.rbac.createSession({
        id: "session-read-runtime",
        userId,
        agentId: "agent-read-runtime",
        delegationId: "delegation-read-runtime",
        rootEntityId,
        taskScope: { rootEntityId },
        expiresAt: "2030-01-01T00:00:00.000Z",
        createdAt: now,
      });
      const adapter = new CodexAgentAdapter(new TeamMemoryGateway(runtime, {
        retrieval: "active-view",
        projectWrites: false,
      }));
      assert.equal(
        (await adapter.listTools(readSession.token)).some((tool) => tool.name === "memory.write"),
        false,
      );
      const denied = await adapter.invokeTool(readSession.token, "memory.write", {
        target: { kind: "memory_entity", name: "Denied" },
        patch: { description: "should not write" },
      });
      assert.equal(denied.decision.allowed, false);
      await runtime.rbac.revokeDelegation("delegation-read-runtime", now);
      await assert.rejects(
        () => adapter.resolvePrincipal(readSession.token),
        /invalid session/,
      );
    } finally {
      runtime.close();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
});
