import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryMemoryRelationStore,
  InMemoryResourceCas,
  InMemoryVectorMemoryStore,
  StoreMemoryProjector,
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
