import assert from "node:assert/strict";
import test from "node:test";

import type {
  PermissionDecision,
  PermissionRequest,
  PolicyEngine,
  TaskScope,
} from "../src/contracts/rbac.ts";
import {
  AuthorizedViewSynchronizer,
  CloudAuthorizedViewAdapter,
  InMemoryLocalAuthorizedViewStore,
  InMemoryPermissionWatermarkAuthority,
  MemoryRetrievalAdapter,
  SynchronizedLocalQuerySource,
} from "../src/memory/index.ts";
import {
  InMemoryCloudMemoryAuthority,
  type CloudMemoryWriteCommand,
} from "../src/history/index.ts";
import { PermissionRouter } from "../src/permission-router.ts";

const timestamp = "2026-06-25T00:00:00.000Z";
const rootEntityId = "root-project-a";

function allow(request: PermissionRequest): PermissionDecision {
  return {
    allowed: true,
    reason: "test",
    subjectId: "user-alice",
    subjectKind: "user",
    rootEntityId: request.rootEntityId,
    action: request.action,
    resourceKind: request.resourceKind,
    matchedRoles: ["role-test"],
    missingActions: [],
    constraints: {},
  };
}

const policy: PolicyEngine = { decide: async (request) => allow(request) };
const subject = { kind: "user" as const, userId: "user-alice" };
const taskScope: TaskScope = {
  rootEntityId,
  allowedTags: ["allowed"],
  allowedResourceIds: ["resource-allowed"],
  relationExpansionPolicy: {
    allowedRelationTypes: ["refers_to"],
    maxDepth: 1,
  },
};

function cloud() {
  return new InMemoryCloudMemoryAuthority({
    entities: [
      {
        id: rootEntityId,
        rootEntityId: null,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "entity-allowed",
        rootEntityId,
        status: "active",
        currentBranchId: "branch-allowed",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "entity-secret",
        rootEntityId,
        status: "active",
        currentBranchId: "branch-secret",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    entityBranches: [
      {
        id: "branch-allowed",
        entityId: "entity-allowed",
        rootEntityId,
        branchRef: "main",
        commitId: "seed",
        title: "Allowed",
        description: "Visible memory",
        tags: ["allowed"],
        importance: 1,
        confidence: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "branch-secret",
        entityId: "entity-secret",
        rootEntityId,
        branchRef: "main",
        commitId: "seed",
        title: "Secret",
        description: "Hidden memory",
        tags: ["secret"],
        importance: 1,
        confidence: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    resources: [
      {
        id: "resource-allowed",
        rootEntityId,
        sourceType: "document",
        title: "Allowed source",
        contentHash: "sha256:allowed",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "resource-secret",
        rootEntityId,
        sourceType: "document",
        title: "Secret source",
        contentHash: "sha256:secret",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    resourceChunks: [
      {
        id: "chunk-allowed",
        rootEntityId,
        resourceId: "resource-allowed",
        chunkIndex: 0,
        text: "Allowed evidence",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "chunk-secret",
        rootEntityId,
        resourceId: "resource-secret",
        chunkIndex: 0,
        text: "Secret evidence",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  });
}

function writeCommand(
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

function syncRequest(scope: TaskScope = taskScope) {
  return {
    subject,
    rootEntityId,
    branchRef: "main",
    action: "read" as const,
    resourceKind: "memory_entity" as const,
    taskScope: scope,
  };
}

test("bootstrap stores only the authorized active snapshot and no cloud history", async () => {
  const authority = cloud();
  const watermarks = new InMemoryPermissionWatermarkAuthority();
  const store = new InMemoryLocalAuthorizedViewStore();
  const synchronizer = new AuthorizedViewSynchronizer(
    new PermissionRouter(
      policy,
      new CloudAuthorizedViewAdapter(authority, watermarks),
    ),
    store,
  );

  const result = await synchronizer.sync(syncRequest());
  if (!("value" in result)) assert.fail("expected bootstrap");
  assert.equal(result.value.kind, "replace");
  const local = store.readView(rootEntityId, "main");
  assert.deepEqual(
    local.entities.map(({ id }) => id),
    [rootEntityId, "entity-allowed"],
  );
  assert.deepEqual(
    local.resources.map(({ id }) => id),
    ["resource-allowed"],
  );
  assert.deepEqual(store.storageManifest(), {
    activeSnapshot: true,
    indexes: true,
    pendingOperations: true,
    syncCursor: true,
    conflicts: true,
    completeCommitHistory: false,
    completeOperationHistory: false,
  });
});

test("incremental sync applies only accepted commits after the local watermark", async () => {
  const authority = cloud();
  const watermarks = new InMemoryPermissionWatermarkAuthority();
  const store = new InMemoryLocalAuthorizedViewStore();
  const synchronizer = new AuthorizedViewSynchronizer(
    new PermissionRouter(
      policy,
      new CloudAuthorizedViewAdapter(authority, watermarks),
    ),
    store,
  );
  await synchronizer.sync(syncRequest());

  const writeRouter = new PermissionRouter(policy, authority);
  await writeRouter.execute(
    writeCommand({
      clientMutationId: "mutation-new-entity",
      action: "write_entity",
      resourceKind: "memory_entity",
      commit: { id: "commit-new-entity" },
      operation: {
        kind: "create_entity",
        id: "operation-new-entity",
        entity: {
          id: "entity-new",
          rootEntityId,
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    }),
  );
  await writeRouter.execute(
    writeCommand({
      clientMutationId: "mutation-new-branch",
      expectedHeadCommitId: "commit-new-entity",
      action: "write_entity_branch",
      resourceKind: "memory_entity_branch",
      commit: { id: "commit-new-branch" },
      operation: {
        kind: "create_entity_branch",
        id: "operation-new-branch",
        branch: {
          id: "branch-new",
          entityId: "entity-new",
          rootEntityId,
          branchRef: "main",
          title: "New allowed memory",
          description: "Incremental",
          tags: ["allowed"],
          importance: 1,
          confidence: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    }),
  );

  const result = await synchronizer.sync(syncRequest());
  if (!("value" in result)) assert.fail("expected delta");
  assert.equal(result.value.kind, "delta");
  assert.deepEqual(result.value.changeCommitIds, [
    "commit-new-entity",
    "commit-new-branch",
  ]);
  assert.equal(
    store
      .readView(rootEntityId, "main")
      .entities.some(({ id }) => id === "entity-new"),
    true,
  );

  const noop = await synchronizer.sync(syncRequest());
  if (!("value" in noop)) assert.fail("expected noop");
  assert.equal(noop.value.kind, "noop");
});

test("permission watermark changes invalidate local reads before resync and remove revoked data", async () => {
  const authority = cloud();
  const watermarks = new InMemoryPermissionWatermarkAuthority();
  const store = new InMemoryLocalAuthorizedViewStore();
  const syncRouter = new PermissionRouter(
    policy,
    new CloudAuthorizedViewAdapter(authority, watermarks),
  );
  const synchronizer = new AuthorizedViewSynchronizer(syncRouter, store);
  await synchronizer.sync(syncRequest());

  const localRetrieval = new PermissionRouter(
    policy,
    new MemoryRetrievalAdapter(
      new SynchronizedLocalQuerySource(store, watermarks),
    ),
  );
  watermarks.advance("user-alice", rootEntityId);
  await assert.rejects(
    () =>
      localRetrieval.execute({
        ...syncRequest(),
        action: "search",
        query: { kind: "keyword", text: "allowed" },
      }),
    /permission watermark changed/,
  );
  assert.equal(store.inspect().valid, false);

  const narrowed: TaskScope = {
    rootEntityId,
    allowedEntityIds: [],
    allowedResourceIds: [],
  };
  const resync = await synchronizer.sync(syncRequest(narrowed));
  if (!("value" in resync)) assert.fail("expected replacement");
  assert.equal(resync.value.kind, "replace");
  assert.deepEqual(
    store.readView(rootEntityId, "main").entities.map(({ id }) => id),
    [rootEntityId],
  );
  assert.equal(store.readView(rootEntityId, "main").resourceChunks.length, 0);
});

test("changing TaskScope atomically replaces the old authorized snapshot", async () => {
  const authority = cloud();
  const watermarks = new InMemoryPermissionWatermarkAuthority();
  const store = new InMemoryLocalAuthorizedViewStore();
  const synchronizer = new AuthorizedViewSynchronizer(
    new PermissionRouter(
      policy,
      new CloudAuthorizedViewAdapter(authority, watermarks),
    ),
    store,
  );
  await synchronizer.sync(syncRequest());

  const result = await synchronizer.sync(
    syncRequest({
      rootEntityId,
      allowedEntityIds: [],
      allowedResourceIds: [],
    }),
  );

  if (!("value" in result)) assert.fail("expected scope replacement");
  assert.equal(result.value.kind, "replace");
  if (result.value.kind !== "replace") {
    assert.fail("expected replace batch");
  }
  assert.equal(result.value.reason, "permission_changed");
  assert.deepEqual(
    store.readView(rootEntityId, "main").entities.map(({ id }) => id),
    [rootEntityId],
  );
});

test("a deleted local view can be rebuilt to the same authorized state", async () => {
  const authority = cloud();
  const watermarks = new InMemoryPermissionWatermarkAuthority();
  const store = new InMemoryLocalAuthorizedViewStore();
  const synchronizer = new AuthorizedViewSynchronizer(
    new PermissionRouter(
      policy,
      new CloudAuthorizedViewAdapter(authority, watermarks),
    ),
    store,
  );
  await synchronizer.sync(syncRequest());
  const before = store.readView(rootEntityId, "main");

  store.clear();
  await synchronizer.sync(syncRequest());

  assert.deepEqual(store.readView(rootEntityId, "main"), before);
});
