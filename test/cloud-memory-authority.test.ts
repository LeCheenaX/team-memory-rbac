import assert from "node:assert/strict";
import test from "node:test";

import type {
  PermissionDecision,
  PermissionRequest,
  PolicyEngine,
} from "../src/contracts/rbac.ts";
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

function command(
  input: Omit<
    CloudMemoryWriteCommand,
    "subject" | "rootEntityId" | "branchRef"
  >,
): CloudMemoryWriteCommand {
  return {
    subject: { kind: "user", userId: "user-alice" },
    rootEntityId,
    branchRef: "main",
    ...input,
  };
}

function authority() {
  return new InMemoryCloudMemoryAuthority({
    entities: [
      {
        id: rootEntityId,
        rootEntityId: null,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  });
}

test("cloud commits are idempotent and advance a monotonic watermark", async () => {
  const cloud = authority();
  const router = new PermissionRouter(policy, cloud);
  const request = command({
    clientMutationId: "mutation-resource-v1",
    action: "import_resource",
    resourceKind: "resource",
    commit: { id: "commit-resource-v1" },
    operation: {
      kind: "create_resource",
      id: "operation-resource-v1",
      revisionId: "revision-resource-v1",
      resource: {
        id: "resource-design",
        rootEntityId,
        sourceType: "document",
        title: "Design",
        contentHash: "sha256:v1",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  });

  const first = await router.execute(request);
  const retry = await router.execute(request);
  if (!("value" in first) || !("value" in retry)) {
    assert.fail("expected accepted cloud writes");
  }
  assert.equal(first.value.status, "accepted");
  assert.deepEqual(retry.value, first.value);
  assert.equal(cloud.commitWatermark(), 1);
  assert.equal(cloud.listCommitRecords(rootEntityId, "main").length, 1);
  assert.equal(cloud.listOutbox().length, 1);

  await assert.rejects(
    () =>
      router.execute({
        ...request,
        commit: { id: "commit-resource-different" },
      }),
    /clientMutationId was already used for a different command/,
  );
});

test("stale non-conflicting writes rebase onto the current head", async () => {
  const cloud = authority();
  const router = new PermissionRouter(policy, cloud);
  await router.execute(
    command({
      clientMutationId: "mutation-resource",
      action: "import_resource",
      resourceKind: "resource",
      commit: { id: "commit-resource" },
      operation: {
        kind: "create_resource",
        id: "operation-resource",
        revisionId: "revision-resource",
        resource: {
          id: "resource-a",
          rootEntityId,
          sourceType: "document",
          title: "A",
          contentHash: "sha256:a",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    }),
  );

  const result = await router.execute(
    command({
      clientMutationId: "mutation-entity",
      action: "write_entity",
      resourceKind: "memory_entity",
      expectedHeadCommitId: undefined,
      commit: { id: "commit-entity" },
      operation: {
        kind: "create_entity",
        id: "operation-entity",
        entity: {
          id: "entity-a",
          rootEntityId,
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    }),
  );

  if (!("value" in result)) assert.fail("expected rebased write");
  assert.equal(result.value.status, "accepted");
  assert.equal(
    cloud.headCommitId(rootEntityId, "main"),
    "commit-entity",
  );
  assert.deepEqual(
    cloud.readActiveView(rootEntityId, "main").entities.map(({ id }) => id),
    [rootEntityId, "entity-a"],
  );
});

test("stale conflicting writes are preserved on a conflict branch without changing target state", async () => {
  const cloud = authority();
  const router = new PermissionRouter(policy, cloud);
  await router.execute(
    command({
      clientMutationId: "mutation-resource-v1",
      action: "import_resource",
      resourceKind: "resource",
      commit: { id: "commit-resource-v1" },
      operation: {
        kind: "create_resource",
        id: "operation-resource-v1",
        revisionId: "revision-resource-v1",
        resource: {
          id: "resource-design",
          rootEntityId,
          sourceType: "document",
          title: "Design",
          contentHash: "sha256:v1",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    }),
  );

  const result = await router.execute(
    command({
      clientMutationId: "mutation-resource-v2",
      action: "import_resource",
      resourceKind: "resource",
      expectedHeadCommitId: undefined,
      commit: { id: "commit-resource-v2" },
      operation: {
        kind: "revise_resource",
        id: "operation-resource-v2",
        resourceId: "resource-design",
        revisionId: "revision-resource-v2",
        contentHash: "sha256:v2",
      },
    }),
  );

  if (!("value" in result)) assert.fail("expected conflict value");
  assert.equal(result.value.status, "conflict");
  if (result.value.status !== "conflict") assert.fail("expected conflict");
  assert.equal(
    cloud.readActiveView(rootEntityId, "main").resources[0]?.contentHash,
    "sha256:v1",
  );
  assert.equal(
    cloud.readConflictView(result.value.conflict.conflictBranchRef)
      ?.resources[0]?.contentHash,
    "sha256:v2",
  );
  assert.equal(
    cloud.headCommitId(rootEntityId, "main"),
    "commit-resource-v1",
  );
  assert.equal(cloud.listConflicts(rootEntityId, "main")[0]?.status, "unresolved");
});

test("equivalent stale changes reuse the authoritative result instead of creating a conflict", async () => {
  const cloud = authority();
  const router = new PermissionRouter(policy, cloud);
  await router.execute(
    command({
      clientMutationId: "mutation-resource-v1",
      action: "import_resource",
      resourceKind: "resource",
      commit: { id: "commit-resource-v1" },
      operation: {
        kind: "create_resource",
        id: "operation-resource-v1",
        revisionId: "revision-resource-v1",
        resource: {
          id: "resource-design",
          rootEntityId,
          sourceType: "document",
          title: "Design",
          contentHash: "sha256:v1",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    }),
  );
  await router.execute(
    command({
      clientMutationId: "mutation-remote-v2",
      expectedHeadCommitId: "commit-resource-v1",
      action: "import_resource",
      resourceKind: "resource",
      commit: { id: "commit-remote-v2" },
      operation: {
        kind: "revise_resource",
        id: "operation-remote-v2",
        resourceId: "resource-design",
        revisionId: "revision-remote-v2",
        contentHash: "sha256:v2",
      },
    }),
  );

  const result = await router.execute(
    command({
      clientMutationId: "mutation-local-v2",
      expectedHeadCommitId: "commit-resource-v1",
      action: "import_resource",
      resourceKind: "resource",
      commit: { id: "commit-local-v2" },
      operation: {
        kind: "revise_resource",
        id: "operation-local-v2",
        resourceId: "resource-design",
        revisionId: "revision-local-v2",
        contentHash: "sha256:v2",
      },
    }),
  );

  if (!("value" in result)) assert.fail("expected equivalent result");
  assert.equal(result.value.status, "accepted");
  assert.equal(result.value.write.commit.id, "commit-remote-v2");
  assert.equal(cloud.listConflicts(rootEntityId, "main").length, 0);
  assert.equal(cloud.commitWatermark(), 2);
});

test("accepted projection can be rebuilt from the authoritative operation log", async () => {
  const cloud = authority();
  const router = new PermissionRouter(policy, cloud);
  await router.execute(
    command({
      clientMutationId: "mutation-entity",
      action: "write_entity",
      resourceKind: "memory_entity",
      commit: { id: "commit-entity" },
      operation: {
        kind: "create_entity",
        id: "operation-entity",
        entity: {
          id: "entity-a",
          rootEntityId,
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    }),
  );
  const before = cloud.readActiveView(rootEntityId, "main");

  await cloud.rebuildActiveProjection();

  assert.deepEqual(cloud.readActiveView(rootEntityId, "main"), before);
  assert.equal(cloud.commitWatermark(), 1);
});
