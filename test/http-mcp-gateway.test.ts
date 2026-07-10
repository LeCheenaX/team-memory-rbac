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
import { unitTestRuntimeConfig } from "./support/runtime-config.ts";

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
  const runtime = await TeamMemoryRuntime.create(unitTestRuntimeConfig({
    directory,
    databaseName: "gateway.db",
  }));
  const gateway = new TeamMemoryGateway(runtime, {
    retrieval: "active-view",
    projectWrites: false,
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
        { action: "commit", resourceKind: "memory_entity" },
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
          clientMutationId: "write-guide",
          target: {
            kind: "memory_entity",
            name: "Gateway Guide",
          },
          patch: {
            title: "Gateway Guide",
            description: "Shared HTTP and MCP behavior",
            tags: ["guide"],
          },
        })
      ).status,
      200,
    );
    await gateway.importResource(adminSession.token, {
      clientMutationId: "import-gateway-resource",
      resourceId: "resource-gateway",
      revisionId: "revision-gateway",
      title: "Gateway Resource",
      sourceType: "document",
      content: "HTTP and MCP share the same projected BM25 retrieval path",
      maxChunkCharacters: 1200,
    });

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
          target: { kind: "memory_entity", name: "Denied" },
          patch: { description: "should not write" },
        }),
      /permission_denied/,
    );

    const history = await fetch(`${base}/history?branchRef=main`, {
      headers: { authorization: `Bearer ${adminSession.token}` },
    });
    assert.equal(history.status, 200);
    const historyPayload = await history.json() as {
      value: { records: { commit: { id: string }; operations: unknown[] }[] };
    };
    const commitIds = historyPayload.value.records.map(({ commit }) => commit.id);
    assert.equal(commitIds[0], "bootstrap-root-commit:root-gateway");
    assert.match(commitIds[1] ?? "", /^commit:memory-write:/);
    assert.equal(commitIds[2], "commit:import-gateway-resource");
    assert.match(commitIds[3] ?? "", /^commit:import-gateway-resource:auto-ingest:chunk:/);
    assert.equal(historyPayload.value.records[1]?.operations.length, 2);

    const duplicate = await post(base, "/memory/write", writeSession.token, {
      clientMutationId: "write-guide-duplicate",
      target: { kind: "memory_entity", name: "Gateway Guide" },
      patch: {
        description: "Shared HTTP and MCP behavior",
        tags: ["guide"],
      },
    });
    const duplicateText = await duplicate.text();
    assert.equal(duplicate.status, 200, duplicateText);
    assert.equal(
      (JSON.parse(duplicateText) as { value: { status: string } }).value.status,
      "duplicate",
    );

    const conflict = await post(base, "/memory/write", writeSession.token, {
      clientMutationId: "write-guide-conflict",
      conflict: true,
      target: { kind: "memory_entity", name: "Gateway Guide" },
      patch: { description: "Gateway Guide now documents conflict capture." },
    });
    const conflictText = await conflict.text();
    assert.equal(conflict.status, 200, conflictText);
    assert.equal(
      (JSON.parse(conflictText) as { value: { extra: { relationType: string } } })
        .value.extra.relationType,
      "contradicts",
    );

    const secondSameName = await post(base, "/memory/write", writeSession.token, {
      clientMutationId: "write-second-same-name",
      target: { kind: "memory_entity", name: "Second Guide" },
      patch: {
        title: "Gateway Guide",
        description: "A separate entity with the same human-readable title.",
      },
    });
    assert.equal(secondSameName.status, 200, await secondSameName.text());
    const ambiguous = await post(base, "/memory/write", writeSession.token, {
      clientMutationId: "write-ambiguous",
      target: { kind: "memory_entity", name: "Gateway Guide" },
      patch: { description: "Should ask the agent to disambiguate." },
    });
    const ambiguousText = await ambiguous.text();
    assert.equal(ambiguous.status, 200, ambiguousText);
    assert.equal(
      (JSON.parse(ambiguousText) as { value: { status: string; extra: { guidance: string } } })
        .value.status,
      "ambiguous",
    );
    assert.equal(
      (JSON.parse(ambiguousText) as { value: { extra: { guidance: string } } })
        .value.extra.guidance,
      "search_or_catalog_first",
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
