import assert from "node:assert/strict";
import test from "node:test";

import type {
  PermissionDecision,
  PermissionRequest,
  PolicyEngine,
} from "../src/contracts/rbac.ts";
import {
  InMemoryAuthorizedQuerySource,
  MemoryRetrievalAdapter,
  normalizeBm25Score,
  type MemoryActiveView,
} from "../src/memory/index.ts";
import { PermissionRouter } from "../src/permission-router.ts";

const rootEntityId = "root-project-a";
const timestamp = "2026-06-25T00:00:00.000Z";

const view: MemoryActiveView = {
  rootEntityId,
  branchRef: "main",
  entities: [
    {
      id: rootEntityId,
      rootEntityId: null,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "workflow",
      rootEntityId,
      status: "active",
      currentBranchId: "workflow-v1",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "step",
      rootEntityId,
      status: "active",
      currentBranchId: "step-v1",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ],
  entityBranches: [
    {
      id: "workflow-v1",
      entityId: "workflow",
      rootEntityId,
      branchRef: "main",
      commitId: "commit-1",
      title: "Release workflow",
      description: "Deploy the application",
      tags: ["workflow", "allowed"],
      embedding: [1, 0],
      importance: 1,
      confidence: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "step-v1",
      entityId: "step",
      rootEntityId,
      branchRef: "main",
      commitId: "commit-1",
      title: "Secret deployment step",
      description: "Internal only",
      tags: ["secret"],
      embedding: [0, 1],
      importance: 1,
      confidence: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ],
  relations: [
    {
      id: "workflow-has-step",
      rootEntityId,
      sourceId: "workflow",
      sourceKind: "memory_entity",
      targetId: "step",
      targetKind: "memory_entity",
      relationType: "has",
      branchRef: "main",
      commitId: "commit-1",
      status: "active",
      weight: 1,
      confidence: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "workflow-evidence",
      rootEntityId,
      sourceId: "workflow",
      sourceKind: "memory_entity",
      targetId: "chunk-1",
      targetKind: "resource_chunk",
      relationType: "refers_to",
      branchRef: "main",
      commitId: "commit-1",
      status: "active",
      weight: 1,
      confidence: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ],
  resources: [
    {
      id: "resource-1",
      rootEntityId,
      sourceType: "document",
      title: "Runbook",
      contentHash: "sha256:runbook",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ],
  resourceChunks: [
    {
      id: "chunk-1",
      rootEntityId,
      resourceId: "resource-1",
      chunkIndex: 0,
      text: "Release workflow evidence",
      embedding: [1, 0],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ],
};

function decision(
  request: PermissionRequest,
  allowed = true,
): PermissionDecision {
  return {
    allowed,
    reason: allowed ? "allowed" : "missing_permission",
    subjectId: "user-alice",
    subjectKind: "user",
    rootEntityId: request.rootEntityId,
    action: request.action,
    resourceKind: request.resourceKind,
    matchedRoles: allowed ? ["role-researcher"] : [],
    missingActions: allowed ? [] : [request.action],
    constraints: {},
  };
}

function request(query: Parameters<typeof router.execute>[0]["query"]) {
  return {
    subject: { kind: "user" as const, userId: "user-alice" },
    rootEntityId,
    branchRef: "main",
    action: "search" as const,
    resourceKind: "memory_entity" as const,
    taskScope: {
      rootEntityId,
      allowedTags: ["allowed", "workflow"],
      allowedResourceIds: ["resource-1"],
      relationExpansionPolicy: {
        allowedRelationTypes: ["has", "refers_to"] as const,
        maxDepth: 1,
      },
    },
    query,
  };
}

const source = new InMemoryAuthorizedQuerySource(
  () => structuredClone(view),
  "local_snapshot",
);
const allowPolicy: PolicyEngine = {
  decide: async (candidate) => decision(candidate),
};
const router = new PermissionRouter(
  allowPolicy,
  new MemoryRetrievalAdapter(source),
);

test("keyword and semantic retrieval use the same authorized source and include evidence", async () => {
  const keyword = await router.execute(
    request({ kind: "keyword", text: "release" }),
  );
  assert.equal(keyword.decision.allowed, true);
  if (!("value" in keyword)) assert.fail("expected retrieval value");
  const entity = keyword.value.items.find(
    (item) => item.kind === "entity",
  );
  assert.equal(entity?.origin, "local_snapshot");
  assert.equal(entity?.kind === "entity" ? entity.evidence.length : 0, 1);

  const semantic = await router.execute(
    request({ kind: "semantic", embedding: [1, 0] }),
  );
  if (!("value" in semantic)) assert.fail("expected semantic value");
  assert.equal(semantic.value.items[0]?.origin, "local_snapshot");
});

test("TaskScope filters entity tags, resources, relation type, and depth", async () => {
  const entities = await router.execute(
    request({ kind: "entity", entityIds: ["workflow", "step"] }),
  );
  if (!("value" in entities)) assert.fail("expected entity value");
  assert.deepEqual(
    entities.value.items.map((item) =>
      item.kind === "entity" ? item.entity.id : item.kind,
    ),
    ["workflow"],
  );

  const tagged = await router.execute(
    request({ kind: "entity", tagsAny: ["workflow"] }),
  );
  if (!("value" in tagged)) assert.fail("expected tagged value");
  assert.deepEqual(
    tagged.value.items.map((item) =>
      item.kind === "entity" ? item.entity.id : item.kind,
    ),
    ["workflow"],
  );

  const excluded = await router.execute(
    request({ kind: "entity", tagsNone: ["workflow"] }),
  );
  if (!("value" in excluded)) assert.fail("expected excluded value");
  assert.deepEqual(excluded.value.items, []);

  const relations = await router.execute(
    request({
      kind: "relations",
      startEntityId: "workflow",
      relationTypes: ["has", "next_is"],
      maxDepth: 3,
    }),
  );
  if (!("value" in relations)) assert.fail("expected relation value");
  assert.deepEqual(
    relations.value.items.map((item) =>
      item.kind === "relation" ? item.relation.id : item.kind,
    ),
    ["workflow-has-step"],
  );
});

test("workflow retrieval expands only workflow relations", async () => {
  const result = await router.execute(
    request({ kind: "workflow", text: "release", maxDepth: 1 }),
  );
  if (!("value" in result)) assert.fail("expected workflow value");
  assert.deepEqual(
    result.value.items.map((item) => item.kind),
    ["entity", "relation"],
  );
});

test("stable recall fuses candidates by layer, tags, names, and relation packing", async () => {
  const recallRouter = new PermissionRouter(
    allowPolicy,
    new MemoryRetrievalAdapter(source, {
      embeddings: { embed: async () => [1, 0] },
      entityExtractor: { extract: () => ["Release workflow"] },
    }),
  );

  const l3 = await recallRouter.execute(
    request({
      kind: "recall",
      text: "Release workflow",
      tagsAny: ["workflow"],
      names: ["Release workflow"],
    }),
  );
  if (!("value" in l3)) assert.fail("expected L3 recall value");
  assert.deepEqual(
    l3.value.items.map((item) => item.kind),
    ["entity"],
  );
  assert.equal(l3.value.items[0]?.kind === "entity" ? l3.value.items[0].branch : undefined, undefined);

  const l2 = await recallRouter.execute(
    request({
      kind: "recall",
      text: "Release workflow",
      layer: "L2",
      tagsAny: ["workflow"],
      limit: 5,
    }),
  );
  if (!("value" in l2)) assert.fail("expected L2 recall value");
  assert.ok(l2.value.items.some(
    (item) =>
      item.kind === "relation" &&
      item.relation.id === "workflow-evidence",
  ));
  assert.ok(l2.value.items.every((item) => item.score >= 0 && item.score <= 1));

  const l1 = await recallRouter.execute(
    request({
      kind: "recall",
      text: "Release workflow evidence",
      layer: "L1",
      limit: 5,
    }),
  );
  if (!("value" in l1)) assert.fail("expected L1 recall value");
  assert.ok(l1.value.items.some(
    (item) => item.kind === "resource_chunk" && item.chunk.id === "chunk-1",
  ));

  assert.equal(
    normalizeBm25Score(5, "short query") >
      normalizeBm25Score(1, "short query"),
    true,
  );
});

test("denied retrieval never reaches the query source", async () => {
  let called = false;
  const deniedSource = new InMemoryAuthorizedQuerySource(() => {
    called = true;
    return view;
  });
  const deniedRouter = new PermissionRouter(
    {
      decide: async (candidate) => decision(candidate, false),
    },
    new MemoryRetrievalAdapter(deniedSource),
  );

  const result = await deniedRouter.execute(
    request({ kind: "keyword", text: "release" }),
  );
  assert.equal(result.decision.allowed, false);
  assert.equal(called, false);
  assert.deepEqual(result.decision.missingActions, ["search"]);
});
