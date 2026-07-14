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

function entityOperation(
  name: string,
  description: string,
  tags: string[] = [],
): Record<string, unknown> {
  return {
    target: "memory_entity",
    op: "create",
    properties: { name, description, tags },
  };
}

function branchOperation(
  entityName: string,
  title: string,
  description: string,
  tags: string[] = [],
): Record<string, unknown> {
  return {
    target: "memory_entity_branch",
    op: "create",
    subject: entityName,
    properties: { name: title, title, description, tags },
  };
}

function relationOperation(
  type: string,
  subject: Record<string, unknown>,
  object: Record<string, unknown>,
): Record<string, unknown> {
  return {
    target: "memory_relation",
    op: "create",
    type,
    subject,
    object,
  };
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
        { action: "import_resource", resourceKind: "resource" },
        { action: "index_resource", resourceKind: "resource" },
        { action: "index_resource", resourceKind: "resource_chunk" },
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
          operations: [
            entityOperation("Gateway Guide", "Shared HTTP and MCP behavior", ["guide"]),
            entityOperation("MCP Adapter", "MCP exposes Team Memory tools.", ["adapter"]),
            branchOperation(
              "Gateway Guide",
              "Gateway Guide stable tools",
              "HTTP and MCP expose the same stable Team Memory behavior.",
              ["guide"],
            ),
            relationOperation(
              "relates_to",
              { target: "memory_entity", name: "Gateway Guide" },
              { target: "memory_entity", name: "MCP Adapter" },
            ),
          ],
        })
      ).status,
      200,
    );
    const rejectedConflictShortcut = await post(base, "/memory/write", writeSession.token, {
      conflict: true,
      operations: [
        branchOperation(
          "Gateway Guide",
          "Invalid conflict shortcut",
          "Top-level conflict must not be accepted.",
        ),
      ],
    });
    assert.equal(rejectedConflictShortcut.status, 400);

    const forbiddenWritePayloads: Array<{
      name: string;
      payload: Record<string, unknown>;
    }> = [
      {
        name: "clientMutationId",
        payload: {
          clientMutationId: "agent-supplied",
          operations: [entityOperation("Invalid", "invalid")],
        },
      },
      {
        name: "entityName",
        payload: {
          operations: [
            {
              target: "memory_entity_branch",
              op: "create",
              entityName: "Gateway Guide",
              properties: { name: "Invalid", desc: "invalid" },
            },
          ],
        },
      },
      {
        name: "top-level title",
        payload: {
          operations: [
            {
              target: "memory_entity",
              op: "create",
              title: "Invalid",
              properties: { name: "Invalid", desc: "invalid" },
            },
          ],
        },
      },
      {
        name: "relationType",
        payload: {
          operations: [
            {
              target: "memory_relation",
              op: "create",
              relationType: "relates_to",
              subject: { target: "memory_entity", name: "Gateway Guide" },
              object: { target: "memory_entity", name: "MCP Adapter" },
            },
          ],
        },
      },
      {
        name: "internal endpoint ids",
        payload: {
          operations: [
            {
              target: "memory_relation",
              op: "create",
              type: "relates_to",
              sourceId: "entity:internal",
              targetId: "entity:internal-2",
              subject: { target: "memory_entity", name: "Gateway Guide" },
              object: { target: "memory_entity", name: "MCP Adapter" },
            },
          ],
        },
      },
      {
        name: "old operation name",
        payload: {
          operations: [
            {
              op: "upsert_memory_entity",
              name: "Invalid",
              description: "invalid",
            },
          ],
        },
      },
    ];
    for (const { name, payload } of forbiddenWritePayloads) {
      const rejected = await post(base, "/memory/write", writeSession.token, payload);
      assert.equal(rejected.status, 400, `${name} should be rejected: ${await rejected.text()}`);
    }

    const rejectedIncludeHistory = await post(base, "/memory/search", readSession.token, {
      query: "Gateway",
      includeHistory: true,
    });
    assert.equal(rejectedIncludeHistory.status, 400);

    const conflictBatch = await post(base, "/memory/write", writeSession.token, {
      operations: [
        branchOperation(
          "Gateway Guide",
          "Gateway Guide corrected stable tools",
          "HTTP exposes stable Team Memory behavior; MCP does not expose generated ids.",
          ["guide", "correction"],
        ),
        relationOperation(
          "contradicts",
          {
            target: "memory_entity_branch",
            parent: "Gateway Guide",
            name: "Gateway Guide corrected stable tools",
          },
          {
            target: "memory_entity_branch",
            parent: "Gateway Guide",
            name: "Gateway Guide stable tools",
          },
        ),
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
      operations: [
        branchOperation(
          "Gateway Guide",
          "Gateway Guide stable tools variant",
          "HTTP and MCP expose stable behavior with updated phrasing.",
        ),
      ],
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
    const resourceRevision = await post(base, "/memory/write", writeSession.token, {
      operations: [
        {
          target: "resource",
          op: "update",
          name: "Gateway Resource",
          properties: {
            content: "HTTP and MCP share a canonical resource revision path",
          },
        },
      ],
    });
    const resourceRevisionText = await resourceRevision.text();
    assert.equal(resourceRevision.status, 200, resourceRevisionText);
    const resourceRevisionValue = JSON.parse(resourceRevisionText) as {
      value: {
        resourceId: string;
        revisionId: string;
        commitIds: string[];
        extra: { ingestion: { status: string } };
      };
    };
    assert.equal(resourceRevisionValue.value.resourceId, "resource-gateway");
    assert.match(resourceRevisionValue.value.revisionId, /^revision:/);
    assert.equal(resourceRevisionValue.value.commitIds.length, 1);
    assert.ok(["indexed", "retryable_failed"].includes(
      resourceRevisionValue.value.extra.ingestion.status,
    ));

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
          operations: [
            entityOperation("Denied", "should not write"),
          ],
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

    const legacyTargetPatch = await post(base, "/memory/write", writeSession.token, {
      target: { kind: "memory_entity", name: "Gateway Guide" },
      patch: {
        description: "Shared HTTP and MCP behavior",
        tags: ["guide"],
      },
    });
    assert.equal(legacyTargetPatch.status, 400, await legacyTargetPatch.text());

    const unsafeConflict = await post(base, "/memory/write", writeSession.token, {
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
      operations: [
        {
          target: "memory_entity",
          op: "update",
          properties: {
            name: "Gateway Guide",
            description: "Gateway Guide is the L3 directory entry for HTTP and MCP behavior.",
            tags: ["guide", "http"],
          },
        },
      ],
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
    const branchCountBeforeDuplicateFact = runtime.history
      .readActiveView("root-gateway", "main")
      .entityBranches
      .filter((branch) => branch.entityId === summaryUpdateValue.value.entityId)
      .length;
    const duplicateFact = await post(base, "/memory/write", writeSession.token, {
      operations: [
        branchOperation(
          "Gateway Guide",
          "Gateway Guide duplicate title",
          "HTTP and MCP expose the same stable Team Memory behavior.",
          ["guide"],
        ),
      ],
    });
    const duplicateFactText = await duplicateFact.text();
    assert.equal(duplicateFact.status, 200, duplicateFactText);
    const duplicateFactValue = JSON.parse(duplicateFactText) as {
      value: { branchId: string; extra: { operationsApplied: string[] } };
    };
    assert.equal(
      duplicateFactValue.value.extra.operationsApplied[0],
      "memory_entity_branch/update_metadata",
    );
    assert.equal(
      runtime.history
        .readActiveView("root-gateway", "main")
        .entityBranches.filter((branch) =>
          branch.entityId === summaryUpdateValue.value.entityId
        )
        .length,
      branchCountBeforeDuplicateFact,
    );
    assert.equal(
      runtime.history
        .readActiveView("root-gateway", "main")
        .entityBranches.find((branch) => branch.id === duplicateFactValue.value.branchId)
        ?.description,
      "HTTP and MCP expose the same stable Team Memory behavior.",
    );

    const branchCountBeforeNewFact = runtime.history
      .readActiveView("root-gateway", "main")
      .entityBranches
      .filter((branch) => branch.entityId === summaryUpdateValue.value.entityId)
      .length;
    const newFact = await post(base, "/memory/write", writeSession.token, {
      operations: [
        branchOperation(
          "Gateway Guide",
          "Gateway Guide stable tools",
          "Gateway Guide keeps operational deployment notes for a separate release checklist.",
          ["guide", "release"],
        ),
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
      branchCountBeforeNewFact + 1,
    );

    const secondSameName = await post(base, "/memory/write", writeSession.token, {
      operations: [
        {
          target: "memory_entity",
          op: "create",
          properties: {
            name: "Second Guide",
            title: "Gateway Guide",
            description: "A separate entity with the same human-readable title.",
          },
        },
      ],
    });
    assert.equal(secondSameName.status, 200, await secondSameName.text());
    const ambiguous = await post(base, "/memory/write", writeSession.token, {
      operations: [
        {
          target: "memory_entity",
          op: "update",
          properties: {
            name: "Gateway Guide",
            description: "Should ask the agent to disambiguate.",
          },
        },
      ],
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

    const branchFirst = await post(base, "/memory/write", writeSession.token, {
      operations: [
        branchOperation(
          "Riverfront",
          "Riverfront is the Nova CRM churn pilot",
          "Riverfront is the Nova CRM customer churn warning pilot.",
          ["project:riverfront", "hermes"],
        ),
      ],
    });
    const branchFirstText = await branchFirst.text();
    assert.equal(branchFirst.status, 200, branchFirstText);
    const branchFirstPayload = JSON.parse(branchFirstText) as {
      value: {
        status: string;
        entityId: string;
        branchId: string;
        commitIds: string[];
        extra: { operationsApplied: string[] };
      };
    };
    assert.equal(branchFirstPayload.value.status, "captured");
    assert.deepEqual(branchFirstPayload.value.extra.operationsApplied, [
      "memory_entity/create",
      "memory_entity_branch/create",
    ]);
    assert.equal(branchFirstPayload.value.commitIds.length, 1);
    const branchFirstView = runtime.history.readActiveView("root-gateway", "main");
    const riverfront = branchFirstView.entities.find((entity) => entity.title === "Riverfront");
    assert.ok(riverfront);
    assert.equal(riverfront.description, "Riverfront is the Nova CRM customer churn warning pilot.");
    assert.ok(branchFirstView.entityBranches.some((branch) =>
      branch.id === branchFirstPayload.value.branchId &&
      branch.entityId === riverfront.id &&
      branch.title === "Riverfront is the Nova CRM churn pilot"
    ));

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
