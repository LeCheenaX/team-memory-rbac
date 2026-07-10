import assert from "node:assert/strict";
import test from "node:test";

import {
  HistoryMemoryProjectionWorker,
  InMemoryHistoryAuthority,
  InMemoryMemoryRelationStore,
  InMemoryResourceCas,
  InMemoryVectorMemoryStore,
  StoreMemoryProjector,
  type EmbeddingProvider,
  type MemoryEntityBranch,
} from "../src/index.ts";

test("memory storage seams retain Qdrant-style payloads without History fields", async () => {
  const vectors = new InMemoryVectorMemoryStore();
  const cas = new InMemoryResourceCas();
  const relations = new InMemoryMemoryRelationStore();
  const branch: MemoryEntityBranch = {
    id: "branch:architecture",
    entityId: "entity:architecture",
    rootEntityId: "root:project",
    branchRef: "main",
    title: "Architecture",
    description: "The accepted architecture.",
    tags: ["architecture"],
    importance: 1,
    confidence: 1,
    status: "active",
    origin: "import",
    pendingId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const projector = new StoreMemoryProjector(cas, vectors, relations);
  await projector.project({ vectorPoints: [{
    collection: "memory_entity_branches",
    id: branch.id,
    vector: [1, 0],
    payload: branch,
  }] });

  const [found] = await vectors.search({
    collection: "memory_entity_branches",
    vector: [1, 0],
    filter: { rootEntityId: "root:project", branchRef: "main" },
  });

  assert.equal(found?.payload.entityBranchId, "branch:architecture");
  assert.equal(found?.payload.commitId, undefined);

  await projector.project({
    resource: { contentHash: "sha256:source", content: "original source" },
  });
  assert.equal((await cas.get("sha256:source"))?.content, "original source");

  await projector.project({ relations: [{
    id: "relation:source",
    rootEntityId: "root:project",
    branchRef: "main",
    sourceId: "entity:architecture",
    sourceKind: "memory_entity",
    targetId: "chunk:source",
    targetKind: "resource_chunk",
    relationType: "refers_to",
    weight: 1,
    confidence: 1,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }] });
  assert.equal(
    (await relations.list({ rootEntityId: "root:project", branchRef: "main" })).length,
    1,
  );
});

test("entity and branch projection use the configured embedding provider", async () => {
  const embeddedTexts: string[] = [];
  const embeddings: EmbeddingProvider = {
    name: "test-projection-provider",
    productionSafe: true,
    embed: async (text) => {
      embeddedTexts.push(text);
      return [0.25, 0.75];
    },
  };
  const history = new InMemoryHistoryAuthority();
  const vectors = new InMemoryVectorMemoryStore();
  const projector = new HistoryMemoryProjectionWorker(
    history,
    new StoreMemoryProjector(
      new InMemoryResourceCas(),
      vectors,
      new InMemoryMemoryRelationStore(),
    ),
    { embeddings },
  );
  await history.execute({
    subject: { kind: "user", userId: "user:projection" },
    rootEntityId: "root:projection",
    branchRef: "main",
    action: "create_root_entity",
    resourceKind: "memory_entity",
    clientMutationId: "projection-root",
    commit: { id: "commit:projection-root" },
    operation: {
      kind: "create_entity",
      id: "operation:projection-root",
      entity: {
        id: "root:projection",
        rootEntityId: null,
        currentBranchId: "branch:projection",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    authorization: {
      allowed: true,
      reason: "test",
      subjectId: "user:projection",
      subjectKind: "user",
      rootEntityId: "root:projection",
      action: "create_root_entity",
      resourceKind: "memory_entity",
      matchedRoles: [],
      missingActions: [],
      constraints: { allowRootEntityMutation: true },
    },
  });
  await history.execute({
    subject: { kind: "user", userId: "user:projection" },
    rootEntityId: "root:projection",
    branchRef: "main",
    action: "commit",
    resourceKind: "memory_entity",
    clientMutationId: "projection-entity-and-branch",
    expectedHeadCommitId: "commit:projection-root",
    commit: { id: "commit:projection-entity-and-branch" },
    operation: {
      kind: "create_entity",
      id: "operation:projection-entity",
      entity: {
        id: "entity:projection",
        rootEntityId: "root:projection",
        currentBranchId: "branch:projection",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    operations: [
      {
        kind: "create_entity",
        id: "operation:projection-entity",
        entity: {
          id: "entity:projection",
          rootEntityId: "root:projection",
          currentBranchId: "branch:projection",
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      {
        kind: "create_entity_branch",
        id: "operation:projection-branch",
        branch: {
          id: "branch:projection",
          entityId: "entity:projection",
          rootEntityId: "root:projection",
          branchRef: "main",
          title: "Projection Branch",
          description: "Branch text uses the configured provider.",
          tags: ["projection"],
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    ],
    authorization: {
      allowed: true,
      reason: "test",
      subjectId: "user:projection",
      subjectKind: "user",
      rootEntityId: "root:projection",
      action: "commit",
      resourceKind: "memory_entity",
      matchedRoles: [],
      missingActions: [],
      constraints: {},
    },
  });

  await projector.project("root:projection", "main");

  assert.ok(embeddedTexts.some((text) => text.includes("entity:projection")));
  assert.ok(embeddedTexts.some((text) => text.includes("Projection Branch")));
  assert.deepEqual(
    (await vectors.get("memory_entity_branches", "branch:projection"))?.vector,
    [0.25, 0.75],
  );
});
