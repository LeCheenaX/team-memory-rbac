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
    branchDedupeThreshold: 0.999,
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
          operations: [
            {
              op: "upsert_memory_entity",
              name: "Gateway Guide",
              description: "Shared HTTP and MCP behavior",
              tags: ["guide"],
            },
            {
              op: "upsert_memory_entity",
              name: "MCP Adapter",
              description: "MCP exposes Team Memory tools.",
              tags: ["adapter"],
            },
            {
              op: "create_memory_entity_branch",
              entityName: "Gateway Guide",
              title: "Gateway Guide stable tools",
              description: "HTTP and MCP expose the same stable Team Memory behavior.",
              tags: ["guide"],
            },
            {
              op: "create_memory_relation",
              relationType: "relates_to",
              source: { kind: "memory_entity", name: "Gateway Guide" },
              target: { kind: "memory_entity", name: "MCP Adapter" },
              description: "Gateway Guide documents MCP behavior.",
            },
          ],
        })
      ).status,
      200,
    );
    const rejectedConflictShortcut = await post(base, "/memory/write", writeSession.token, {
      clientMutationId: "write-conflict-shortcut",
      conflict: true,
      operations: [
        {
          op: "create_memory_entity_branch",
          entityName: "Gateway Guide",
          title: "Invalid conflict shortcut",
          description: "Top-level conflict must not be accepted.",
        },
      ],
    });
    assert.equal(rejectedConflictShortcut.status, 400);

    const conflictBatch = await post(base, "/memory/write", writeSession.token, {
      clientMutationId: "write-explicit-contradiction",
      operations: [
        {
          op: "create_memory_entity_branch",
          entityName: "Gateway Guide",
          title: "Gateway Guide corrected stable tools",
          description: "HTTP exposes stable Team Memory behavior; MCP does not expose generated ids.",
          tags: ["guide", "correction"],
        },
        {
          op: "create_memory_relation",
          relationType: "contradicts",
          source: {
            kind: "memory_entity_branch",
            entityName: "Gateway Guide",
            name: "Gateway Guide corrected stable tools",
          },
          target: {
            kind: "memory_entity_branch",
            entityName: "Gateway Guide",
            name: "Gateway Guide stable tools",
          },
          description: "The corrected branch contradicts the older generated-id wording.",
        },
      ],
    });
    const conflictText = await conflictBatch.text();
    assert.equal(conflictBatch.status, 200, conflictText);
    assert.ok(
      runtime.history.readActiveView("root-gateway", "main").relations.some((relation) =>
        relation.relationType === "contradicts" &&
        relation.sourceKind === "memory_entity_branch" &&
        relation.targetKind === "memory_entity_branch"
      ),
    );

    const beforeAutoContradicts = runtime.history
      .readActiveView("root-gateway", "main")
      .relations
      .filter((relation) => relation.relationType === "contradicts")
      .length;
    const nonConflictBranch = await post(base, "/memory/write", writeSession.token, {
      clientMutationId: "write-non-conflict-branch",
      target: {
        kind: "memory_entity_branch",
        name: "Gateway Guide stable tools",
      },
      patch: {
        title: "Gateway Guide stable tools variant",
        description: "HTTP and MCP expose stable behavior with updated phrasing.",
      },
    });
    const nonConflictText = await nonConflictBranch.text();
    assert.equal(nonConflictBranch.status, 200, nonConflictText);
    assert.equal(
      runtime.history
        .readActiveView("root-gateway", "main")
        .relations
        .filter((relation) => relation.relationType === "contradicts")
        .length,
      beforeAutoContradicts,
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
        entities: Array<{ name: string; summary: string; status: string; tags: string[]; id?: string; branch?: unknown }>;
        tags: Array<{ tag: string; count: number; names: string[] }>;
      };
    };
    const guideEntity = catalog.value.entities.find((entity) => entity.name === "Gateway Guide");
    assert.ok(guideEntity);
    assert.equal(guideEntity.summary, "Shared HTTP and MCP behavior");
    assert.equal("id" in guideEntity, false);
    assert.equal("branch" in guideEntity, false);
    assert.deepEqual(catalog.value.tags, [
      { tag: "adapter", count: 1, names: ["MCP Adapter"] },
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
    assert.ok(commitIds.includes("commit:import-gateway-resource"));
    assert.ok(commitIds.some((commitId) =>
      /^commit:import-gateway-resource:auto-ingest:chunk:/.test(commitId)
    ));
    assert.equal(historyPayload.value.records[1]?.operations.length, 4);

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

    const unsafeConflict = await post(base, "/memory/write", writeSession.token, {
      clientMutationId: "write-guide-conflict",
      conflict: true,
      target: { kind: "memory_entity", name: "Gateway Guide" },
      patch: { description: "Gateway Guide now documents conflict capture." },
    });
    assert.equal(unsafeConflict.status, 400, await unsafeConflict.text());

    const branchCountBeforeSummary = runtime.history
      .readActiveView("root-gateway", "main")
      .entityBranches
      .length;
    const summaryUpdate = await post(base, "/memory/write", writeSession.token, {
      clientMutationId: "write-guide-summary",
      target: { kind: "memory_entity", name: "Gateway Guide" },
      patch: {
        description: "Gateway Guide is the L3 directory entry for HTTP and MCP behavior.",
        tags: ["guide", "http"],
      },
    });
    const summaryUpdateText = await summaryUpdate.text();
    assert.equal(summaryUpdate.status, 200, summaryUpdateText);
    const summaryUpdateValue = JSON.parse(summaryUpdateText) as {
      value: { entityId: string };
    };
    assert.equal(
      runtime.history
        .readActiveView("root-gateway", "main")
        .entityBranches
        .length,
      branchCountBeforeSummary,
    );
    assert.ok(summaryUpdateValue.value.entityId);
    const duplicateFact = await post(base, "/memory/write", writeSession.token, {
      clientMutationId: "write-guide-duplicate-fact",
      operations: [
        {
          op: "create_memory_entity_branch",
          entityName: "Gateway Guide",
          title: "Gateway Guide duplicate title",
          description: "HTTP and MCP expose the same stable Team Memory behavior.",
          tags: ["guide"],
        },
      ],
    });
    const duplicateFactText = await duplicateFact.text();
    assert.equal(duplicateFact.status, 200, duplicateFactText);
    const duplicateFactValue = JSON.parse(duplicateFactText) as {
      value: { branchId: string; extra: { operationsApplied: string[] } };
    };
    assert.equal(
      duplicateFactValue.value.extra.operationsApplied[0],
      "update_memory_entity_branch_metadata",
    );
    assert.equal(
      runtime.history
        .readActiveView("root-gateway", "main")
        .entityBranches.filter((branch) =>
          branch.entityId === summaryUpdateValue.value.entityId
        )
        .length,
      1,
    );
    assert.equal(
      runtime.history
        .readActiveView("root-gateway", "main")
        .entityBranches.find((branch) => branch.id === duplicateFactValue.value.branchId)
        ?.description,
      "HTTP and MCP expose the same stable Team Memory behavior.",
    );

    const newFact = await post(base, "/memory/write", writeSession.token, {
      clientMutationId: "write-guide-new-fact",
      operations: [
        {
          op: "create_memory_entity_branch",
          entityName: "Gateway Guide",
          title: "Gateway Guide stable tools",
          description: "Gateway Guide keeps operational deployment notes for a separate release checklist.",
          tags: ["guide", "release"],
        },
      ],
    });
    assert.equal(newFact.status, 200, await newFact.text());
    assert.equal(
      runtime.history
        .readActiveView("root-gateway", "main")
        .entityBranches.filter((branch) =>
          branch.entityId === summaryUpdateValue.value.entityId
        )
        .length,
      2,
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
