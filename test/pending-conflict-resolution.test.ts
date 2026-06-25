import assert from "node:assert/strict";
import test from "node:test";

import type {
  PermissionDecision,
  PermissionRequest,
  PolicyEngine,
} from "../src/contracts/rbac.ts";
import {
  AuthorizedViewSynchronizer,
  CloudAuthorizedViewAdapter,
  InMemoryCloudMemoryAuthority,
  InMemoryLocalAuthorizedViewStore,
  InMemoryPendingOverlay,
  InMemoryPermissionWatermarkAuthority,
  MemoryRetrievalAdapter,
  type CloudMemoryWriteCommand,
  type ConflictResolutionCommand,
} from "../src/memory/index.ts";
import { PermissionRouter } from "../src/permission-router.ts";

const timestamp = "2026-06-25T00:00:00.000Z";
const rootEntityId = "root-project-a";
const subject = { kind: "user" as const, userId: "user-admin" };

function allow(request: PermissionRequest): PermissionDecision {
  return {
    allowed: true,
    reason: "test",
    subjectId: "user-admin",
    subjectKind: "user",
    rootEntityId: request.rootEntityId,
    action: request.action,
    resourceKind: request.resourceKind,
    matchedRoles: ["role-root-admin"],
    missingActions: [],
    constraints: { allowRootEntityMutation: true },
  };
}

const policy: PolicyEngine = { decide: async (request) => allow(request) };

function seed() {
  return {
    entities: [
      {
        id: rootEntityId,
        rootEntityId: null,
        status: "active" as const,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "entity-workflow",
        rootEntityId,
        status: "active" as const,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    resources: [
      {
        id: "resource-runbook",
        rootEntityId,
        sourceType: "document" as const,
        title: "Runbook",
        contentHash: "sha256:runbook",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };
}

function write(
  input: Omit<
    CloudMemoryWriteCommand,
    "subject" | "rootEntityId" | "branchRef"
  >,
): CloudMemoryWriteCommand {
  return {
    subject,
    rootEntityId,
    branchRef: "main",
    ...input,
  };
}

async function setup() {
  const cloud = new InMemoryCloudMemoryAuthority(seed());
  const watermarks = new InMemoryPermissionWatermarkAuthority();
  const local = new InMemoryLocalAuthorizedViewStore();
  const synchronizer = new AuthorizedViewSynchronizer(
    new PermissionRouter(
      policy,
      new CloudAuthorizedViewAdapter(cloud, watermarks),
    ),
    local,
  );
  const syncRequest = {
    subject,
    rootEntityId,
    branchRef: "main",
    action: "read" as const,
    resourceKind: "memory_entity" as const,
    taskScope: { rootEntityId },
  };
  await synchronizer.sync(syncRequest);
  return {
    cloud,
    local,
    synchronizer,
    syncRequest,
    writeRouter: new PermissionRouter(policy, cloud),
  };
}

function resolutionAuthorization(command: ConflictResolutionCommand) {
  return {
    ...command,
    authorization: {
      ...allow(command),
      allowed: true as const,
    },
  };
}

test("a staged pending write is immediately searchable and survives local restart", async () => {
  const { local } = await setup();
  const pending = new InMemoryPendingOverlay(local);
  await pending.stage(
    write({
      clientMutationId: "local-chunk",
      action: "write_resource_chunk",
      resourceKind: "resource_chunk",
      commit: { id: "commit-local-chunk" },
      operation: {
        kind: "create_resource_chunk",
        id: "operation-local-chunk",
        chunk: {
          id: "chunk-shared",
          rootEntityId,
          resourceId: "resource-runbook",
          chunkIndex: 0,
          text: "Local pending instructions",
          embedding: [1, 0],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    }),
    {
      sessionId: "session-1",
      ownerUserId: "user-admin",
    },
  );
  const retrieval = new PermissionRouter(
    policy,
    new MemoryRetrievalAdapter(pending.querySource()),
  );
  const result = await retrieval.execute({
    subject,
    rootEntityId,
    branchRef: "main",
    action: "search",
    resourceKind: "resource_chunk",
    taskScope: { rootEntityId },
    query: { kind: "keyword", text: "pending" },
  });
  if (!("value" in result)) assert.fail("expected local result");
  assert.equal(result.value.items[0]?.origin, "local_pending");

  const restarted = new InMemoryPendingOverlay(local, pending.inspect());
  const semantic = await new PermissionRouter(
    policy,
    new MemoryRetrievalAdapter(restarted.querySource()),
  ).execute({
    subject,
    rootEntityId,
    branchRef: "main",
    action: "search",
    resourceKind: "resource_chunk",
    taskScope: { rootEntityId },
    query: { kind: "semantic", embedding: [1, 0] },
  });
  if (!("value" in semantic)) assert.fail("expected restarted result");
  assert.equal(semantic.value.items[0]?.origin, "local_pending");
  assert.equal(restarted.inspect().records[0]?.provenance.sessionId, "session-1");
});

test("pending entities and relations are immediately available to entity and graph retrieval", async () => {
  const { local } = await setup();
  const pending = new InMemoryPendingOverlay(local);
  const provenance = {
    sessionId: "session-graph",
    ownerUserId: "user-admin",
  };
  await pending.stage(
    write({
      clientMutationId: "local-entity",
      action: "write_entity",
      resourceKind: "memory_entity",
      commit: { id: "commit-local-entity" },
      operation: {
        kind: "create_entity",
        id: "operation-local-entity",
        entity: {
          id: "entity-local",
          rootEntityId,
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    }),
    provenance,
  );
  await pending.stage(
    write({
      clientMutationId: "local-entity-branch",
      action: "write_entity_branch",
      resourceKind: "memory_entity_branch",
      commit: { id: "commit-local-entity-branch" },
      operation: {
        kind: "create_entity_branch",
        id: "operation-local-entity-branch",
        branch: {
          id: "branch-entity-local",
          entityId: "entity-local",
          rootEntityId,
          branchRef: "main",
          title: "Local graph node",
          description: "Pending entity",
          tags: ["pending"],
          importance: 1,
          confidence: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    }),
    provenance,
  );
  await pending.stage(
    write({
      clientMutationId: "local-relation",
      action: "write_relation",
      resourceKind: "memory_relation",
      commit: { id: "commit-local-relation" },
      operation: {
        kind: "create_relation",
        id: "operation-local-relation",
        relation: {
          id: "relation-local",
          rootEntityId,
          sourceId: rootEntityId,
          sourceKind: "memory_entity",
          targetId: "entity-local",
          targetKind: "memory_entity",
          relationType: "has",
          branchRef: "main",
          status: "active",
          weight: 1,
          confidence: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    }),
    provenance,
  );
  const retrieval = new PermissionRouter(
    policy,
    new MemoryRetrievalAdapter(pending.querySource()),
  );
  const entity = await retrieval.execute({
    subject,
    rootEntityId,
    branchRef: "main",
    action: "search",
    resourceKind: "memory_entity",
    taskScope: { rootEntityId },
    query: { kind: "entity", text: "graph node" },
  });
  if (!("value" in entity)) assert.fail("expected pending entity");
  assert.equal(entity.value.items[0]?.origin, "local_pending");

  const relation = await retrieval.execute({
    subject,
    rootEntityId,
    branchRef: "main",
    action: "traverse_relation",
    resourceKind: "memory_relation",
    taskScope: { rootEntityId },
    query: {
      kind: "relations",
      startEntityId: rootEntityId,
      maxDepth: 1,
    },
  });
  if (!("value" in relation)) assert.fail("expected pending relation");
  assert.equal(relation.value.items[0]?.origin, "local_pending");
});

test("unresolved remote conflict keeps the pending overlay visible; keep-target resolution removes it", async () => {
  const {
    cloud,
    local,
    synchronizer,
    syncRequest,
    writeRouter,
  } = await setup();
  const pending = new InMemoryPendingOverlay(local);
  await pending.stage(
    write({
      clientMutationId: "local-chunk",
      action: "write_resource_chunk",
      resourceKind: "resource_chunk",
      commit: { id: "commit-local-chunk" },
      operation: {
        kind: "create_resource_chunk",
        id: "operation-local-chunk",
        chunk: {
          id: "chunk-shared",
          rootEntityId,
          resourceId: "resource-runbook",
          chunkIndex: 0,
          text: "Local version",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    }),
    { sessionId: "session-local", ownerUserId: "user-admin" },
  );
  await writeRouter.execute(
    write({
      clientMutationId: "remote-chunk",
      action: "write_resource_chunk",
      resourceKind: "resource_chunk",
      commit: { id: "commit-remote-chunk" },
      operation: {
        kind: "create_resource_chunk",
        id: "operation-remote-chunk",
        chunk: {
          id: "chunk-shared",
          rootEntityId,
          resourceId: "resource-runbook",
          chunkIndex: 0,
          text: "Remote version",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    }),
  );
  await pending.push(writeRouter);
  await pending.push(writeRouter);
  assert.equal(cloud.listConflicts(rootEntityId, "main").length, 1);
  await synchronizer.sync(syncRequest);
  pending.reconcile(cloud.listCommitRecords(rootEntityId, "main"));

  assert.equal(pending.inspect().records[0]?.status, "conflicted");
  assert.equal(
    (await pending.materialize()).resourceChunks[0]?.text,
    "Local version",
  );

  const conflictId = pending.inspect().records[0]?.cloudConflictId;
  assert.ok(conflictId);
  await cloud.resolveConflict(
    resolutionAuthorization({
      subject,
      rootEntityId,
      branchRef: "main",
      action: "merge",
      resourceKind: "memory_entity",
      clientMutationId: "resolve-keep-remote",
      commit: { id: "commit-resolution-keep-remote" },
      conflictIds: [conflictId],
      resolutionKind: "keep_target",
    }),
  );
  await synchronizer.sync(syncRequest);
  pending.reconcile(cloud.listCommitRecords(rootEntityId, "main"));

  assert.equal(pending.inspect().records[0]?.status, "rejected");
  assert.equal(
    (await pending.materialize()).resourceChunks[0]?.text,
    "Remote version",
  );
});

test("a pending delete continues to hide a remotely updated object until resolution", async () => {
  const {
    cloud,
    local,
    synchronizer,
    syncRequest,
    writeRouter,
  } = await setup();
  const pending = new InMemoryPendingOverlay(local);
  await pending.stage(
    write({
      clientMutationId: "local-delete-resource",
      action: "tombstone_resource",
      resourceKind: "resource",
      commit: { id: "commit-local-delete-resource" },
      operation: {
        kind: "tombstone_resource",
        id: "operation-local-delete-resource",
        targetId: "resource-runbook",
      },
    }),
    { sessionId: "session-delete", ownerUserId: "user-admin" },
  );
  await writeRouter.execute(
    write({
      clientMutationId: "remote-update-resource",
      action: "import_resource",
      resourceKind: "resource",
      commit: { id: "commit-remote-update-resource" },
      operation: {
        kind: "revise_resource",
        id: "operation-remote-update-resource",
        resourceId: "resource-runbook",
        revisionId: "revision-remote-update-resource",
        contentHash: "sha256:remote-update",
      },
    }),
  );
  await pending.push(writeRouter);
  await synchronizer.sync(syncRequest);
  pending.reconcile(cloud.listCommitRecords(rootEntityId, "main"));
  assert.equal((await pending.materialize()).resources.length, 0);

  const conflictId = pending.inspect().records[0]?.cloudConflictId;
  assert.ok(conflictId);
  await cloud.resolveConflict(
    resolutionAuthorization({
      subject,
      rootEntityId,
      branchRef: "main",
      action: "merge",
      resourceKind: "memory_entity",
      clientMutationId: "resolve-keep-update",
      commit: { id: "commit-resolution-keep-update" },
      conflictIds: [conflictId],
      resolutionKind: "keep_target",
    }),
  );
  await synchronizer.sync(syncRequest);
  pending.reconcile(cloud.listCommitRecords(rootEntityId, "main"));
  assert.equal(
    (await pending.materialize()).resources[0]?.contentHash,
    "sha256:remote-update",
  );
});

test("take-incoming and manual-merge resolutions create explicit authoritative resolution commits", async () => {
  const {
    cloud,
    local,
    synchronizer,
    syncRequest,
    writeRouter,
  } = await setup();
  const pending = new InMemoryPendingOverlay(local);
  await pending.stage(
    write({
      clientMutationId: "local-branch",
      action: "write_entity_branch",
      resourceKind: "memory_entity_branch",
      commit: { id: "commit-local-branch" },
      operation: {
        kind: "create_entity_branch",
        id: "operation-local-branch",
        branch: {
          id: "branch-local",
          entityId: "entity-workflow",
          rootEntityId,
          branchRef: "main",
          title: "Local workflow",
          description: "Local choice",
          tags: ["workflow"],
          importance: 1,
          confidence: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    }),
    { sessionId: "session-local", ownerUserId: "user-admin" },
  );
  await writeRouter.execute(
    write({
      clientMutationId: "remote-branch",
      action: "write_entity_branch",
      resourceKind: "memory_entity_branch",
      commit: { id: "commit-remote-branch" },
      operation: {
        kind: "create_entity_branch",
        id: "operation-remote-branch",
        branch: {
          id: "branch-remote",
          entityId: "entity-workflow",
          rootEntityId,
          branchRef: "main",
          title: "Remote workflow",
          description: "Remote choice",
          tags: ["workflow"],
          importance: 1,
          confidence: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    }),
  );
  await pending.push(writeRouter);
  const conflictId = pending.inspect().records[0]?.cloudConflictId;
  assert.ok(conflictId);

  const taken = await cloud.resolveConflict(
    resolutionAuthorization({
      subject,
      rootEntityId,
      branchRef: "main",
      action: "merge",
      resourceKind: "memory_entity",
      clientMutationId: "resolve-take-local",
      commit: { id: "commit-resolution-take-local" },
      conflictIds: [conflictId],
      resolutionKind: "take_incoming",
    }),
  );
  assert.equal(taken.resolution.resolution?.resolutionKind, "take_incoming");
  assert.equal(taken.applied.length, 2);
  assert.equal(
    cloud
      .readActiveView(rootEntityId, "main")
      .entityBranches.find(({ id }) => id === "branch-local")?.title,
    "Local workflow",
  );
  assert.equal(
    cloud
      .readActiveView(rootEntityId, "main")
      .entityBranches.some(({ id }) => id === "branch-remote"),
    false,
  );

  await synchronizer.sync(syncRequest);
  pending.reconcile(cloud.listCommitRecords(rootEntityId, "main"));
  assert.equal(pending.inspect().records[0]?.status, "resolved");

  // Create a second conflict and resolve it with an explicit manual value.
  await writeRouter.execute(
    write({
      clientMutationId: "remote-resource-v1",
      expectedHeadCommitId: cloud.headCommitId(rootEntityId, "main"),
      action: "import_resource",
      resourceKind: "resource",
      commit: { id: "commit-remote-resource-v1" },
      operation: {
        kind: "revise_resource",
        id: "operation-remote-resource-v1",
        resourceId: "resource-runbook",
        revisionId: "revision-remote-resource-v1",
        contentHash: "sha256:remote",
      },
    }),
  );
  const staleHead = taken.resolution.commit.id;
  const localConflict = await writeRouter.execute(
    write({
      clientMutationId: "incoming-resource-v1",
      expectedHeadCommitId: staleHead,
      action: "import_resource",
      resourceKind: "resource",
      commit: { id: "commit-incoming-resource-v1" },
      operation: {
        kind: "revise_resource",
        id: "operation-incoming-resource-v1",
        resourceId: "resource-runbook",
        revisionId: "revision-incoming-resource-v1",
        contentHash: "sha256:incoming",
      },
    }),
  );
  if (
    !("value" in localConflict) ||
    localConflict.value.status !== "conflict"
  ) {
    assert.fail("expected resource conflict");
  }
  const manual = await cloud.resolveConflict(
    resolutionAuthorization({
      subject,
      rootEntityId,
      branchRef: "main",
      action: "merge",
      resourceKind: "memory_entity",
      clientMutationId: "resolve-manual-resource",
      commit: { id: "commit-resolution-manual-resource" },
      conflictIds: [localConflict.value.conflict.id],
      resolutionKind: "manual_merge",
      manualAction: "import_resource",
      manualResourceKind: "resource",
      manualOperation: {
        kind: "revise_resource",
        id: "operation-manual-resource",
        resourceId: "resource-runbook",
        revisionId: "revision-manual-resource",
        contentHash: "sha256:manual",
      },
    }),
  );
  assert.equal(manual.resolution.resolution?.resolutionKind, "manual_merge");
  assert.equal(
    cloud.readActiveView(rootEntityId, "main").resources[0]?.contentHash,
    "sha256:manual",
  );
});
