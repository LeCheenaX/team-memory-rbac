import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMemoryModelInvariants,
  effectiveRootEntityId,
  type MemoryEntity,
  type MemoryRelation,
} from "../src/contracts/memory.ts";
import {
  assertHistoryModelInvariants,
  type MemoryBranch,
  type MemoryCommit,
} from "../src/contracts/history.ts";

const timestamp = "2026-06-25T00:00:00.000Z";

test("memory core models preserve root ownership and evidence tracing", () => {
  const root: MemoryEntity = {
    id: "root-project-a",
    rootEntityId: null,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const entity: MemoryEntity = {
    id: "entity-architecture",
    rootEntityId: root.id,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const branch: MemoryBranch = {
    id: "branch-main",
    rootEntityId: root.id,
    branchRef: "main",
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const commit: MemoryCommit = {
    id: "commit-1",
    rootEntityId: root.id,
    branchRef: branch.branchRef,
    operationIds: ["operation-1"],
    actor: {
      kind: "user",
      id: "user-alice",
    },
    createdAt: timestamp,
  };
  const evidenceRelation: MemoryRelation = {
    id: "relation-evidence",
    rootEntityId: root.id,
    sourceId: entity.id,
    sourceKind: "memory_entity",
    targetId: "chunk-readme-0",
    targetKind: "resource_chunk",
    relationType: "refers_to",
    role: "source_chunk",
    weight: 1,
    confidence: 1,
    branchRef: branch.branchRef,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  assert.equal(effectiveRootEntityId(root), root.id);
  assert.equal(effectiveRootEntityId(entity), root.id);
  assert.doesNotThrow(() =>
    assertMemoryModelInvariants({
      entities: [root, entity],
      relations: [evidenceRelation],
    }),
  );
  assert.doesNotThrow(() =>
    assertHistoryModelInvariants({ branches: [branch], commits: [commit] }),
  );
});

test("branch and commit reject missing root ownership", () => {
  assert.throws(
    () =>
      assertHistoryModelInvariants({
        branches: [
          {
            id: "branch-main",
            rootEntityId: "",
            branchRef: "main",
            status: "active",
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      }),
    /rootEntityId must be a non-empty string/,
  );
});
