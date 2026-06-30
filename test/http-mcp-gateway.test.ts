import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { McpTeamMemoryAdapter } from "../adapters/agent/transports.ts";
import { createTeamMemoryServer } from "../adapters/http/server.ts";
import {
  bootstrapDevelopment,
  TeamMemoryRuntime,
} from "../adapters/runtime/development-stack.ts";
import { TeamMemoryGateway } from "../adapters/runtime/gateway.ts";

const now = "2026-06-29T00:00:00.000Z";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "team-memory-rbac-"));
}

async function removeTemporaryDirectory(directory: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 500));
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}

async function closeServer(server: ReturnType<typeof createTeamMemoryServer>) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function post(
  base: string,
  path: string,
  token: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

test("HTTP and MCP expose the same authenticated memory gateway without payload identity overrides", async () => {
  const directory = await temporaryDirectory();
  const runtime = await TeamMemoryRuntime.create({
    libsqlUrl: `file:${join(directory, "gateway.db")}`,
    casDirectory: join(directory, "cas"),
    qdrantUrl: "http://127.0.0.1:6333",
    objectStoreUrl: "http://127.0.0.1:9000",
  });
  const gateway = new TeamMemoryGateway(runtime, {
    retrieval: "active-view",
  });
  const server = createTeamMemoryServer(gateway);
  try {
    const adminSession = await bootstrapDevelopment(runtime, {
      rootEntityId: "root-gateway",
      userId: "user-gateway",
      displayName: "Gateway User",
      sessionId: "session-admin",
      sessionExpiresAt: "2030-01-01T00:00:00.000Z",
      now,
    });
    await runtime.rbac.saveAgent({
      id: "agent-read",
      ownerUserId: "user-gateway",
      agentType: "sub_agent",
      displayName: "Read Agent",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await runtime.rbac.saveAgent({
      id: "agent-write",
      ownerUserId: "user-gateway",
      agentType: "curator_agent",
      displayName: "Write Agent",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await runtime.rbac.saveDelegation({
      id: "delegation-read",
      agentId: "agent-read",
      ownerUserId: "user-gateway",
      rootEntityId: "root-gateway",
      permissions: [
        { action: "read", resourceKind: "memory_entity" },
        { action: "search", resourceKind: "memory_entity" },
      ],
      delegatedBy: "user-gateway",
      delegatedAt: now,
      status: "active",
    });
    await runtime.rbac.saveDelegation({
      id: "delegation-write",
      agentId: "agent-write",
      ownerUserId: "user-gateway",
      rootEntityId: "root-gateway",
      permissions: [
        { action: "read", resourceKind: "memory_entity" },
        { action: "search", resourceKind: "memory_entity" },
        { action: "write_entity", resourceKind: "memory_entity" },
        {
          action: "write_entity_branch",
          resourceKind: "memory_entity_branch",
        },
      ],
      delegatedBy: "user-gateway",
      delegatedAt: now,
      status: "active",
    });
    const readSession = await runtime.rbac.createSession({
      id: "session-read",
      userId: "user-gateway",
      agentId: "agent-read",
      delegationId: "delegation-read",
      rootEntityId: "root-gateway",
      taskScope: { rootEntityId: "root-gateway" },
      expiresAt: "2030-01-01T00:00:00.000Z",
      createdAt: now,
    });
    const writeSession = await runtime.rbac.createSession({
      id: "session-write",
      userId: "user-gateway",
      agentId: "agent-write",
      delegationId: "delegation-write",
      rootEntityId: "root-gateway",
      taskScope: { rootEntityId: "root-gateway" },
      expiresAt: "2030-01-01T00:00:00.000Z",
      createdAt: now,
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    if (address === null || typeof address === "string") return;
    const base = `http://127.0.0.1:${address.port}`;

    assert.equal(
      (
        await post(base, "/memory/write", writeSession.token, {
          clientMutationId: "write-entity",
          action: "write_entity",
          resourceKind: "memory_entity",
          commit: { id: "commit-entity", message: "Create guide" },
          operation: {
            kind: "create_entity",
            id: "operation-entity",
            entity: {
              id: "entity-guide",
              rootEntityId: "root-gateway",
              currentBranchId: "branch-guide",
              status: "active",
              createdAt: now,
              updatedAt: now,
            },
          },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await post(base, "/memory/write", writeSession.token, {
          clientMutationId: "write-branch",
          action: "write_entity_branch",
          resourceKind: "memory_entity_branch",
          commit: { id: "commit-branch", message: "Describe guide" },
          operation: {
            kind: "create_entity_branch",
            id: "operation-branch",
            branch: {
              id: "branch-guide",
              entityId: "entity-guide",
              rootEntityId: "root-gateway",
              branchRef: "main",
              title: "Gateway Guide",
              description: "Shared HTTP and MCP behavior",
              tags: ["guide"],
              importance: 1,
              confidence: 1,
              status: "active",
              createdAt: now,
              updatedAt: now,
            },
          },
        })
      ).status,
      200,
    );

    const httpSearch = await post(base, "/memory/search", readSession.token, {
      branchRef: "main",
      query: { kind: "entity", text: "Gateway" },
    });
    const httpSearchText = await httpSearch.text();
    assert.equal(httpSearch.status, 200, httpSearchText);
    assert.equal(
      (JSON.parse(httpSearchText) as { value: { items: unknown[] } }).value
        .items.length,
      1,
    );

    const mcp = new McpTeamMemoryAdapter(gateway);
    const mcpSearch = await mcp.callTool(
      readSession.token,
      "memory.search",
      {
        branchRef: "main",
        query: { kind: "entity", text: "Gateway" },
      },
    ) as { value: { items: unknown[] } };
    assert.equal(mcpSearch.value.items.length, 1);
    await assert.rejects(
      () =>
        mcp.callTool(readSession.token, "memory.write", {
          clientMutationId: "denied-write",
          action: "write_entity",
          resourceKind: "memory_entity",
          commit: { id: "commit-denied" },
          operation: {
            kind: "create_entity",
            id: "operation-denied",
            entity: {
              id: "entity-denied",
              rootEntityId: "root-gateway",
              status: "active",
              createdAt: now,
              updatedAt: now,
            },
          },
        }),
      /permission_denied/,
    );

    const history = await fetch(`${base}/history?branchRef=main`, {
      headers: { authorization: `Bearer ${adminSession.token}` },
    });
    assert.equal(history.status, 200);
    assert.deepEqual(
      ((await history.json()) as { value: { records: { commit: { id: string } }[] } })
        .value.records.map(({ commit }) => commit.id),
      ["bootstrap-root-commit:root-gateway", "commit-entity", "commit-branch"],
    );

    const unsafe = await post(base, "/memory/search", readSession.token, {
      rootEntityId: "other-root",
      branchRef: "main",
      query: { kind: "entity", text: "Gateway" },
    });
    assert.equal(unsafe.status, 400);
    assert.equal(
      ((await unsafe.json()) as { error: { code: string } }).error.code,
      "validation_failed",
    );
  } finally {
    await closeServer(server);
    runtime.close();
    await removeTemporaryDirectory(directory);
  }
});
