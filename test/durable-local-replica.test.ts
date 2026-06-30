import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileSystemLocalAuthorizedWorkingReplica } from "../src/adapters/filesystem/local-replica.ts";
import {
  AuthorizedWorkingReplicaSynchronizer,
  InMemoryPermissionWatermarkAuthority,
  PermissionRouter,
  SynchronizedLocalQuerySource,
  type AuthorizedSyncBatch,
  type AuthorizedSyncRequest,
  type CloudCommitRecord,
  type MemoryAdapter,
  type PermissionDecision,
  type PermissionRequest,
  type PolicyEngine,
} from "../src/index.ts";

const now = "2026-06-29T00:00:00.000Z";

const identity = {
  subjectId: "agent-local",
  rootEntityId: "root-local",
  branchRef: "main",
  taskScopeHash: "scope:{\"rootEntityId\":\"root-local\"}",
  commitWatermark: 1,
  permissionWatermark: "1",
};

const nextIdentity = {
  ...identity,
  commitWatermark: 2,
};

const snapshot = {
  rootEntityId: "root-local",
  branchRef: "main",
  entities: [
    {
      id: "root-local",
      rootEntityId: null,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    },
  ],
  entityBranches: [],
  relations: [],
  resources: [],
  resourceChunks: [],
};

const deltaEntity = {
  id: "entity-local",
  rootEntityId: "root-local",
  currentBranchId: "branch-local",
  status: "active" as const,
  createdAt: now,
  updatedAt: now,
};

const deltaBranch = {
  id: "branch-local",
  entityId: "entity-local",
  rootEntityId: "root-local",
  branchRef: "main",
  title: "Offline Gateway Notes",
  description: "Searchable after restart without cloud reads",
  tags: ["offline"],
  importance: 1,
  confidence: 1,
  status: "active" as const,
  createdAt: now,
  updatedAt: now,
};

function record(sequence: number, commitId: string): CloudCommitRecord {
  return {
    sequence,
    clientMutationId: `mutation-${sequence}`,
    targetBranchRef: "main",
    storedBranchRef: "main",
    conflictKeys: [`entity:${commitId}`],
    commit: {
      id: commitId,
      rootEntityId: "root-local",
      branchRef: "main",
      operationIds: [],
      actor: { kind: "agent", id: "agent-local" },
      createdAt: now,
    },
    operations: [],
    status: "accepted",
  };
}

class AllowAllPolicy implements PolicyEngine {
  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    const subjectId =
      request.subject.kind === "user"
        ? request.subject.userId
        : request.subject.agentId;
    return {
      allowed: true,
      reason: "test",
      subjectId,
      subjectKind: request.subject.kind,
      rootEntityId: request.rootEntityId,
      action: request.action,
      resourceKind: request.resourceKind,
      matchedRoles: ["role-test"],
      missingActions: [],
      constraints: {},
    };
  }
}

class ScriptedSyncAdapter
  implements MemoryAdapter<AuthorizedSyncBatch, AuthorizedSyncRequest>
{
  readonly seen: AuthorizedSyncRequest[] = [];

  async execute(request: AuthorizedSyncRequest): Promise<AuthorizedSyncBatch> {
    this.seen.push(structuredClone(request));
    if (request.knownCommitWatermark === undefined) {
      return {
        kind: "replace",
        reason: "bootstrap",
        identity,
        snapshot,
        changeCommitIds: ["commit-1"],
        historyRecords: [record(1, "commit-1")],
      };
    }
    return {
      kind: "delta",
      identity: nextIdentity,
      delta: {
        entities: [deltaEntity],
        entityBranches: [deltaBranch],
        relations: [],
        resources: [],
        resourceChunks: [],
        removeEntityCascadeIds: [],
        removeEntityBranchIds: [],
        removeRelationIds: [],
        removeResourceCascadeIds: [],
        removeResourceChunkIds: [],
      },
      changeCommitIds: ["commit-2"],
      historyRecords: [record(2, "commit-2")],
    };
  }
}

test("filesystem local replica survives restart and resumes sync from the durable watermark", async () => {
  const directory = await mkdtemp(join(tmpdir(), "team-memory-replica-"));
  try {
    const adapter = new ScriptedSyncAdapter();
    const replica = new FileSystemLocalAuthorizedWorkingReplica(directory);
    const router = new PermissionRouter(new AllowAllPolicy(), adapter);
    const request = {
      subject: {
        kind: "agent" as const,
        agentId: "agent-local",
        ownerUserId: "user-local",
      },
      rootEntityId: "root-local",
      branchRef: "main",
      action: "read" as const,
      resourceKind: "memory_entity" as const,
      taskScope: { rootEntityId: "root-local" },
    };
    await new AuthorizedWorkingReplicaSynchronizer(router, replica).sync(
      request,
    );
    replica.replacePendingOperations([
      { id: "pending-1", status: "conflicted" },
    ]);

    const restarted = new FileSystemLocalAuthorizedWorkingReplica(directory);
    assert.equal(restarted.inspect().identity?.commitWatermark, 1);
    assert.deepEqual(restarted.inspect().pendingOperations, [
      { id: "pending-1", status: "conflicted" },
    ]);

    const resumedAdapter = new ScriptedSyncAdapter();
    await new AuthorizedWorkingReplicaSynchronizer(
      new PermissionRouter(new AllowAllPolicy(), resumedAdapter),
      restarted,
    ).sync(request);
    assert.equal(resumedAdapter.seen[0]?.knownCommitWatermark, 1);
    assert.equal(
      restarted.inspect().snapshot?.entities.some(
        (entity) => entity.id === "entity-local",
      ),
      true,
    );

    const watermarks = new InMemoryPermissionWatermarkAuthority();
    watermarks.advance("agent-local", "root-local");
    const localQuery = new SynchronizedLocalQuerySource(
      restarted,
      watermarks,
    );
    assert.equal(
      (
        await localQuery.entitySearch(
          {
            rootEntityId: "root-local",
            branchRef: "main",
            taskScope: { rootEntityId: "root-local" },
          },
          { text: "Offline" },
        )
      )[0]?.entity.id,
      "entity-local",
    );
    watermarks.advance("agent-local", "root-local");
    await assert.rejects(
      () =>
        localQuery.entitySearch(
          {
            rootEntityId: "root-local",
            branchRef: "main",
            taskScope: { rootEntityId: "root-local" },
          },
          { text: "Offline" },
        ),
      /permission watermark changed/,
    );
    assert.equal(
      new FileSystemLocalAuthorizedWorkingReplica(directory).inspect().valid,
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
