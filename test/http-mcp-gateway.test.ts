import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { McpTeamMemoryAdapter } from "../src/adapters/agent/transports.ts";
import { createTeamMemoryServer } from "../src/adapters/http/server.ts";
import {
  bootstrapDevelopment,
  TeamMemoryRuntime,
} from "../src/adapters/runtime/development-stack.ts";
import { TeamMemoryGateway } from "../src/adapters/runtime/gateway.ts";

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
  const gateway = new TeamMemoryGateway(runtime);
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
        { action: "read", resourceKind: "resource_chunk" },
        { action: "search", resourceKind: "resource_chunk" },
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
        { action: "write_resource_chunk", resourceKind: "resource_chunk" },
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

    const toolsResponse = await fetch(`${base}/agent/tools`, {
      headers: { authorization: `Bearer ${readSession.token}` },
    });
    const toolsText = await toolsResponse.text();
    assert.equal(toolsResponse.status, 200, toolsText);
    assert.ok(
      (JSON.parse(toolsText) as { value: Array<{ name: string }> }).value
        .some((tool) => tool.name === "memory.catalog"),
    );
    assert.deepEqual(
      (JSON.parse(toolsText) as { value: Array<{ name: string }> }).value
        .map((tool) => tool.name),
      ["memory.catalog", "memory.search"],
    );

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
    await gateway.importResource(adminSession.token, {
      clientMutationId: "import-gateway-resource",
      resourceId: "resource-gateway",
      title: "Gateway Resource",
      sourceType: "document",
      content: "HTTP and MCP resource backing content",
    });
    const chunkWrite = await post(base, "/memory/write", writeSession.token, {
      clientMutationId: "write-chunk",
      action: "write_resource_chunk",
      resourceKind: "resource_chunk",
      commit: { id: "commit-chunk", message: "Index chunk" },
      operation: {
        kind: "create_resource_chunk",
        id: "operation-chunk",
        chunk: {
          id: "chunk-gateway",
          rootEntityId: "root-gateway",
          resourceId: "resource-gateway",
          chunkIndex: 0,
          text: "HTTP and MCP share the same projected BM25 retrieval path",
          status: "active",
          metadata: { revisionId: "revision-gateway" },
          createdAt: now,
          updatedAt: now,
        },
      },
    });
    const chunkWriteText = await chunkWrite.text();
    assert.equal(chunkWrite.status, 200, chunkWriteText);

    const httpSearch = await post(base, "/memory/search", readSession.token, {
      query: "Gateway",
      tagsAny: ["guide"],
    });
    const httpSearchText = await httpSearch.text();
    assert.equal(httpSearch.status, 200, httpSearchText);
    assert.equal(
      (JSON.parse(httpSearchText) as { value: { items: unknown[] } }).value
        .items.length,
      1,
    );
    const httpCatalog = await fetch(`${base}/memory/catalog`, {
      headers: { authorization: `Bearer ${readSession.token}` },
    });
    const httpCatalogText = await httpCatalog.text();
    assert.equal(httpCatalog.status, 200, httpCatalogText);
    const catalog = JSON.parse(httpCatalogText) as {
      value: {
        entities: Array<{ name: string; status: string; tags: string[] }>;
        tags: Array<{ tag: string; count: number; names: string[] }>;
      };
    };
    assert.ok(catalog.value.entities.some((entity) =>
      entity.name === "Gateway Guide" &&
      entity.tags.includes("guide")
    ));
    assert.deepEqual(catalog.value.tags, [
      { tag: "guide", count: 1, names: ["Gateway Guide"] },
    ]);
    const keywordSearch = await post(base, "/memory/search", readSession.token, {
      query: "projected BM25",
      layer: "L1",
      limit: 5,
    });
    const keywordSearchText = await keywordSearch.text();
    assert.equal(keywordSearch.status, 200, keywordSearchText);
    assert.equal(
      (JSON.parse(keywordSearchText) as { value: { items: unknown[] } }).value
        .items.length,
      1,
    );

    const mcp = new McpTeamMemoryAdapter(gateway);
    const mcpSearch = await mcp.callTool(
      readSession.token,
      "memory.search",
      {
        query: "Gateway",
        tagsAny: ["guide"],
      },
    ) as { value: { items: unknown[] } };
    assert.equal(mcpSearch.value.items.length, 1);
    const mcpCatalog = await mcp.callTool(
      readSession.token,
      "memory.catalog",
      {},
    ) as { entities: Array<{ name: string }> } | { value: { entities: Array<{ name: string }> } };
    const mcpCatalogValue = "value" in mcpCatalog ? mcpCatalog.value : mcpCatalog;
    assert.ok(mcpCatalogValue.entities.some((entity) => entity.name === "Gateway Guide"));
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
      [
        "bootstrap-root-commit:root-gateway",
        "commit-entity",
        "commit-branch",
        "commit:import-gateway-resource",
        "commit-chunk",
      ],
    );

    const unsafe = await post(base, "/memory/search", readSession.token, {
      rootEntityId: "other-root",
      query: "Gateway",
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
