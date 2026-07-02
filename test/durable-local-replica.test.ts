import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
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

const chunkText = "Offline resource chunk survives restart";
const chunkHash = `sha256:${createHash("sha256").update(chunkText).digest("hex")}`;

const deltaResource = {
  id: "resource-local",
  rootEntityId: "root-local",
  sourceType: "document" as const,
  title: "Offline source",
  contentHash: chunkHash,
  status: "active" as const,
  metadata: { content: chunkText },
  createdAt: now,
  updatedAt: now,
};

const deltaChunk = {
  id: "chunk-local",
  rootEntityId: "root-local",
  resourceId: "resource-local",
  chunkIndex: 0,
  text: chunkText,
  contentHash: chunkHash,
  sourceType: "document" as const,
  status: "active" as const,
  createdAt: now,
  updatedAt: now,
};

const deltaRelation = {
  id: "relation-local",
  rootEntityId: "root-local",
  sourceId: "entity-local",
  sourceKind: "memory_entity" as const,
  targetId: "chunk-local",
  targetKind: "resource_chunk" as const,
  relationType: "refers_to" as const,
  weight: 1,
  confidence: 1,
  branchRef: "main",
  status: "active" as const,
  createdAt: now,
  updatedAt: now,
};

function casPath(directory: string, contentHash: string): string {
  const hex = contentHash.replace("sha256:", "");
  return join(directory, "cas", "objects", "sha256", hex.slice(0, 2), hex);
}

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
        relations: [deltaRelation],
        resources: [deltaResource],
        resourceChunks: [deltaChunk],
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
    assert.equal(
      await readFile(casPath(directory, chunkHash), "utf8"),
      chunkText,
    );
    assert.match(
      await readFile(join(directory, "vectors", "memory_entity_branches.json"), "utf8"),
      /branch-local/,
    );
    assert.match(
      await readFile(join(directory, "vectors", "resource_chunks.json"), "utf8"),
      /chunk-local/,
    );
    assert.match(
      await readFile(join(directory, "relations", "memory_relations.json"), "utf8"),
      /relation-local/,
    );
    assert.match(
      await readFile(join(directory, "history", "records.json"), "utf8"),
      /commit-2/,
    );
    assert.match(
      await readFile(join(directory, "pending", "operations.json"), "utf8"),
      /pending-1/,
    );
    await unlink(join(directory, "state.json"));
    const recoveredFromStores = new FileSystemLocalAuthorizedWorkingReplica(directory);
    assert.equal(
      recoveredFromStores.inspect().snapshot?.resourceChunks[0]?.id,
      "chunk-local",
    );
    assert.equal(recoveredFromStores.inspect().historyRecords.length, 2);

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
    const invalidated = new FileSystemLocalAuthorizedWorkingReplica(directory);
    assert.equal(invalidated.inspect().valid, false);
    assert.deepEqual(invalidated.inspect().pendingOperations, []);
    assert.deepEqual(invalidated.inspect().conflicts, []);
    assert.equal(
      await readFile(join(directory, "relations", "memory_relations.json"), "utf8"),
      "[]\n",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
