import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryLocalAuthorizedWorkingReplica,
  syncEventsForBatch,
  type AuthorizedViewIdentity,
  type CloudCommitRecord,
} from "../src/index.ts";

const identity: AuthorizedViewIdentity = {
  subjectId: "user-alice",
  rootEntityId: "root-project-a",
  branchRef: "main",
  taskScopeHash: "scope:null",
  commitWatermark: 1,
  permissionWatermark: "1",
};

const record: CloudCommitRecord = {
  sequence: 1,
  clientMutationId: "mutation-1",
  targetBranchRef: "main",
  storedBranchRef: "main",
  conflictKeys: ["entity:root-project-a"],
  commit: {
    id: "commit-1",
    rootEntityId: "root-project-a",
    branchRef: "main",
    operationIds: ["operation-1"],
    actor: { kind: "user", id: "user-alice" },
    createdAt: "2026-06-26T00:00:00.000Z",
  },
  operations: [],
  status: "accepted",
};

const snapshot = {
  rootEntityId: "root-project-a",
  branchRef: "main",
  entities: [],
  entityBranches: [],
  relations: [],
  resources: [],
  resourceChunks: [],
};

test("working replica retains only its authorized History subset and emits permission events", () => {
  const replica = new InMemoryLocalAuthorizedWorkingReplica();
  replica.replace(identity, snapshot);
  replica.replaceHistory([record]);
  replica.replacePendingOperations([{ id: "pending-1" }]);

  assert.deepEqual(
    replica.inspect().historyRecords.map(({ commit }) => commit.id),
    ["commit-1"],
  );
  assert.deepEqual(replica.inspect().pendingOperations, [{ id: "pending-1" }]);
  assert.deepEqual(replica.storageManifest(), {
    resourceCas: true,
    vectorPayloads: true,
    memoryRelations: true,
    historyOperationTree: true,
    pendingOperations: true,
    syncCursor: true,
    conflicts: true,
    completeCommitHistory: false,
    completeOperationHistory: false,
  });

  assert.deepEqual(
    syncEventsForBatch({
      kind: "replace",
      reason: "permission_changed",
      identity,
      snapshot,
      changeCommitIds: ["commit-1"],
      historyRecords: [record],
    }).map(({ kind }) => kind),
    ["history_commit_accepted", "permission_changed", "memory_state_delta"],
  );
});
