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
  SpacyEntityExtractor,
  calibrateSemanticCandidateFloor,
  normalizeBm25Score,
  type EntityRetrievalItem,
  type MemoryActiveView,
  type MemoryQueryContext,
  type MemoryQuerySource,
  type MemoryRetrievalItem,
  type RelationRetrievalItem,
} from "../src/memory/index.ts";
import { PermissionRouter } from "../src/permission-router.ts";
import { unitTestEmbeddingProvider } from "./support/runtime-config.ts";

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
      name: "Release workflow",
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
  new MemoryRetrievalAdapter(source, { embeddings: unitTestEmbeddingProvider() }),
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
  const relationPack = l2.value.items.find(
    (item) =>
      item.kind === "entity" &&
      item.packedRelations?.some(
        (relation) => relation.id === "workflow-evidence",
      ),
  );
  assert.equal(relationPack?.kind, "entity");
  assert.deepEqual(
    relationPack?.kind === "entity"
      ? relationPack.evidence.map((chunk) => chunk.id)
      : [],
    ["chunk-1"],
  );
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

test("L2 recall returns a contradicts relation and both endpoints as one composite", async () => {
  const contradictionView: MemoryActiveView = {
    rootEntityId,
    branchRef: "main",
    entities: [
      {
        id: "old-fact",
        rootEntityId,
        name: "Old deployment fact",
        status: "active",
        currentBranchId: "old-fact-v1",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "corrected-fact",
        rootEntityId,
        name: "Corrected deployment fact",
        status: "active",
        currentBranchId: "corrected-fact-v1",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    entityBranches: [
      {
        id: "old-fact-v1",
        entityId: "old-fact",
        rootEntityId,
        branchRef: "main",
        commitId: "commit-old",
        title: "Old deployment fact",
        description: "Deploy on Friday",
        tags: ["allowed"],
        importance: 1,
        confidence: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "corrected-fact-v1",
        entityId: "corrected-fact",
        rootEntityId,
        branchRef: "main",
        commitId: "commit-corrected",
        title: "Corrected deployment fact",
        description: "Deploy on Monday",
        tags: ["allowed"],
        importance: 1,
        confidence: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    relations: [
      {
        id: "corrected-contradicts-old",
        rootEntityId,
        sourceId: "corrected-fact-v1",
        sourceKind: "memory_entity_branch",
        targetId: "old-fact-v1",
        targetKind: "memory_entity_branch",
        relationType: "contradicts",
        branchRef: "main",
        commitId: "commit-corrected",
        status: "active",
        weight: 1,
        confidence: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    resources: [],
    resourceChunks: [],
  };
  const contradictionRouter = new PermissionRouter(
    allowPolicy,
    new MemoryRetrievalAdapter(
      new InMemoryAuthorizedQuerySource(() => contradictionView),
      {
        embeddings: unitTestEmbeddingProvider(),
        entityExtractor: { extract: () => [] },
      },
    ),
  );

  const result = await contradictionRouter.execute({
    ...request({
      kind: "recall",
      text: "Old deployment fact",
      layer: "L2",
      limit: 1,
    }),
    taskScope: {
      rootEntityId,
      allowedTags: ["allowed"],
      relationExpansionPolicy: {
        allowedRelationTypes: ["contradicts"],
        maxDepth: 1,
      },
    },
  });

  if (!("value" in result)) assert.fail("expected L2 recall value");
  assert.equal(result.value.items.length, 1);
  const [composite] = result.value.items;
  assert.equal(composite?.kind, "entity");
  if (composite?.kind !== "entity") assert.fail("expected entity composite");
  assert.deepEqual(
    composite.packedRelations?.map((relation) => relation.id),
    ["corrected-contradicts-old"],
  );
  assert.deepEqual(
    composite.packedBranches?.map((branch) => branch.id),
    ["corrected-fact-v1"],
  );
});

test("explicit names seed the entity and all authorized has children before query signals", async () => {
  const riverfrontBranches = [
    {
      id: "riverfront-openclaw",
      title: "与 OpenClaw 的关系",
      description: "OpenClaw 推送客服工单摘要。",
      embedding: [0.429295, 0],
    },
    {
      id: "riverfront-naming",
      title: "命名约定",
      description: "正式项目名是 Riverfront。",
      embedding: [0.753146, 0],
    },
    {
      id: "riverfront-release",
      title: "发布前检查流程",
      description: "发布前先检查流失预警配置。",
      embedding: [0.168533, 0],
    },
  ].map((branch) => ({
    ...branch,
    entityId: "riverfront",
    rootEntityId,
    branchRef: "main",
    tags: ["allowed"],
    importance: 1,
    confidence: 1,
    status: "active" as const,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  const riverfrontView: MemoryActiveView = {
    rootEntityId,
    branchRef: "main",
    entities: [
      {
        id: "riverfront",
        rootEntityId,
        name: "Riverfront",
        description: "Nova CRM customer churn warning pilot.",
        status: "active",
        currentBranchId: "riverfront-release",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    entityBranches: riverfrontBranches,
    relations: riverfrontBranches.map((branch) => ({
      id: `riverfront-has-${branch.id}`,
      rootEntityId,
      sourceId: "riverfront",
      sourceKind: "memory_entity" as const,
      targetId: branch.id,
      targetKind: "memory_entity_branch" as const,
      relationType: "has" as const,
      branchRef: "main",
      status: "active" as const,
      weight: 1,
      confidence: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    })),
    resources: [],
    resourceChunks: [],
  };
  const riverfrontRouter = new PermissionRouter(
    allowPolicy,
    new MemoryRetrievalAdapter(
      new InMemoryAuthorizedQuerySource(() => riverfrontView),
      {
        embeddings: { embed: async () => [1, 0] },
        entityExtractor: { extract: () => ["Riverfront"] },
        recallTopP: 1,
      },
    ),
  );

  const result = await riverfrontRouter.execute(
    request({
      kind: "recall",
      text: "Riverfront 流失预警试点 OpenClaw 发布前检查",
      names: ["Riverfront"],
      layer: "L2",
      limit: 10,
    }),
  );

  if (!("value" in result)) assert.fail("expected Riverfront recall value");
  assert.deepEqual(
    result.value.items
      .filter(
        (item): item is EntityRetrievalItem =>
          item.kind === "entity" && item.branch !== undefined,
      )
      .map((item) => item.branch?.title)
      .sort(),
    riverfrontBranches.map((branch) => branch.title).sort(),
  );
  assert.deepEqual(
    result.value.items
      .filter((item): item is RelationRetrievalItem => item.kind === "relation")
      .map((item) => item.relation.id)
      .sort(),
    riverfrontBranches
      .map((branch) => `riverfront-has-${branch.id}`)
      .sort(),
  );
  assert.deepEqual(result.value.diagnostics?.extractedAtoms, ["Riverfront"]);
  assert.equal(result.value.diagnostics?.laneCandidates.exactName, 1);
  assert.ok(
    (result.value.diagnostics?.laneCandidates.nameKeyword ?? 0) > 0,
  );
  assert.equal(result.value.diagnostics?.relationExpansions, 3);
  assert.equal(result.value.diagnostics?.finalCandidates, 6);
  assert.ok((result.value.diagnostics?.thresholdPruned ?? -1) >= 0);
});

test("unresolved explicit names return a structured warning instead of silent empty recall", async () => {
  const result = await router.execute(
    request({
      kind: "recall",
      text: "Release workflow",
      names: ["Missing visible entity"],
      layer: "L3",
      limit: 5,
    }),
  );

  if (!("value" in result)) assert.fail("expected unresolved-name recall value");
  assert.deepEqual(result.value.items, []);
  assert.deepEqual(result.value.warnings, [
    {
      code: "unresolved_names",
      field: "names",
      unresolvedNames: ["Missing visible entity"],
    },
  ]);
});

test("spaCy extraction exposes independent atomic facts for every query", () => {
  const calls: Array<{ text: string; maxAtoms: number }> = [];
  const extractor = new SpacyEntityExtractor((text, maxAtoms) => {
    calls.push({ text, maxAtoms });
    return [
      "Riverfront 流失预警试点",
      "OpenClaw",
      "发布前检查",
      "OpenClaw",
    ];
  });

  assert.deepEqual(extractor.extract("reported full query"), [
    "Riverfront 流失预警试点",
    "OpenClaw",
    "发布前检查",
  ]);
  assert.deepEqual(calls, [{ text: "reported full query", maxAtoms: 8 }]);
});
test("semantic floor calibration records related and unrelated fixed-seed scores", async () => {
  const facts = new Map<string, number[]>([
    ["发布前需要检查流失预警试点的全部配置", [1, 0]],
    ["客服工单摘要会同步到正式项目知识中", [1, 0]],
    ["发布", [0.168533, Math.sqrt(1 - 0.168533 ** 2)]],
    ["客服", [0.429295, Math.sqrt(1 - 0.429295 ** 2)]],
    ["天气", [0, 1]],
    ["烹饪", [0, 1]],
  ]);
  const calibration = await calibrateSemanticCandidateFloor(
    {
      embed: async (text) => facts.get(text) ?? [0, 0],
    },
    "nomic-embed-text",
    [
      {
        fact: "发布前需要检查流失预警试点的全部配置",
        relatedKeyword: "发布",
        unrelatedKeyword: "天气",
      },
      {
        fact: "客服工单摘要会同步到正式项目知识中",
        relatedKeyword: "客服",
        unrelatedKeyword: "烹饪",
      },
    ],
  );

  assert.equal(calibration.model, "nomic-embed-text");
  assert.deepEqual(
    calibration.relatedSimilarities.map((score) => Number(score.toFixed(6))),
    [0.168533, 0.429295],
  );
  assert.deepEqual(calibration.unrelatedSimilarities, [0, 0]);
  assert.equal(calibration.recommendedFloor, 0.1);
});

test("query-only recall uses token-aware BM25 across entity and branch fields", async () => {
  const queryOnlyView: MemoryActiveView = {
    rootEntityId,
    branchRef: "main",
    entities: [
      {
        id: "riverfront-query-only",
        rootEntityId,
        name: "Riverfront",
        status: "active",
        currentBranchId: "riverfront-query-only-release",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    entityBranches: [
      {
        id: "riverfront-query-only-release",
        entityId: "riverfront-query-only",
        rootEntityId,
        branchRef: "main",
        title: "Release checklist",
        description: "OpenClaw integration must be checked before publishing.",
        tags: ["allowed"],
        importance: 1,
        confidence: 1,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    relations: [],
    resources: [],
    resourceChunks: [],
  };
  const queryOnlyRouter = new PermissionRouter(
    allowPolicy,
    new MemoryRetrievalAdapter(
      new InMemoryAuthorizedQuerySource(() => queryOnlyView),
      {
        embeddings: { embed: async () => [0, 0] },
        entityExtractor: { extract: () => [] },
        recallTopP: 1,
      },
    ),
  );

  const result = await queryOnlyRouter.execute(
    request({
      kind: "recall",
      text: "Riverfront OpenClaw release",
      layer: "L2",
      limit: 5,
    }),
  );

  if (!("value" in result)) assert.fail("expected query-only recall value");
  assert.equal(result.value.items[0]?.kind, "entity");
  assert.equal(
    result.value.items[0]?.kind === "entity"
      ? result.value.items[0].branch?.id
      : undefined,
    "riverfront-query-only-release",
  );
});

test("recall uses top-P score coverage with limit as a hard cap", async () => {
  const candidates = Array.from({ length: 20 }, (_, index): EntityRetrievalItem => {
    const id = `top-p-${String(index + 1).padStart(2, "0")}`;
    return {
      kind: "entity",
      entity: {
        id,
        rootEntityId,
        status: "active",
        currentBranchId: `${id}-branch`,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      branch: {
        id: `${id}-branch`,
        entityId: id,
        rootEntityId,
        branchRef: "main",
        commitId: "commit-top-p",
        title: `Top P item ${index + 1}`,
        description: "Allowed top-P candidate",
        tags: ["allowed"],
        embedding: [1, 0],
        importance: 1,
        confidence: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      evidence: [],
      score: 0.5,
      origin: "local_snapshot",
    };
  });
  const keywordLimits: Array<number | undefined> = [];
  const semanticLimits: Array<number | undefined> = [];
  const topPSource: MemoryQuerySource = {
    async keywordSearch(
      _context: MemoryQueryContext,
      _text: string,
      limit?: number,
    ): Promise<MemoryRetrievalItem[]> {
      keywordLimits.push(limit);
      return candidates.map((candidate) => ({
        ...structuredClone(candidate),
        score: 5,
      }));
    },
    async semanticSearch(
      _context: MemoryQueryContext,
      _embedding: number[],
      limit?: number,
    ): Promise<MemoryRetrievalItem[]> {
      semanticLimits.push(limit);
      return candidates.map((candidate) => structuredClone(candidate));
    },
    async entitySearch(): Promise<EntityRetrievalItem[]> {
      return [];
    },
    async expandRelations(): Promise<RelationRetrievalItem[]> {
      return [];
    },
    async relationsForObject(): Promise<[]> {
      return [];
    },
    async resolveObjects(): Promise<[]> {
      return [];
    },
    async evidenceFor(): Promise<Map<string, []>> {
      return new Map();
    },
  };
  const recallRouter = new PermissionRouter(
    allowPolicy,
    new MemoryRetrievalAdapter(topPSource, {
      embeddings: { embed: async () => [1, 0] },
      entityExtractor: { extract: () => ["top-p"] },
      recallTopP: 0.8,
    }),
  );

  const result = await recallRouter.execute(
    request({
      kind: "recall",
      text: "top-p coverage",
      layer: "L3",
      limit: 12,
    }),
  );

  if (!("value" in result)) assert.fail("expected top-P recall value");
  assert.deepEqual(keywordLimits, [48, 48]);
  assert.deepEqual(semanticLimits, [48, 48]);
  assert.deepEqual(
    result.value.items.map((item) =>
      item.kind === "entity" ? item.entity.id : item.kind,
    ),
    candidates.slice(0, 12).map((item) => item.entity.id),
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
    new MemoryRetrievalAdapter(deniedSource, { embeddings: unitTestEmbeddingProvider() }),
  );

  const result = await deniedRouter.execute(
    request({ kind: "keyword", text: "release" }),
  );
  assert.equal(result.decision.allowed, false);
  assert.equal(called, false);
  assert.deepEqual(result.decision.missingActions, ["search"]);
});
