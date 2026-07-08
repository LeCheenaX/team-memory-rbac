import assert from "node:assert/strict";
import test from "node:test";

import type {
  PermissionDecision,
  PermissionRequest,
  PolicyEngine,
} from "../src/contracts/rbac.ts";
import {
  InMemoryMemoryAuthority,
  type MemoryWriteCommand,
} from "../src/memory/index.ts";
import { PermissionRouter } from "../src/permission-router.ts";
import {
  InMemoryRbacAuthority,
  ScopedPolicyEngine,
} from "../src/rbac/index.ts";
import { contractFixtures } from "./support/contract-fixtures.ts";

const timestamp = "2026-06-25T00:00:00.000Z";
const rootEntityId = "root-project-a";

function rootEntity() {
  return {
    id: rootEntityId,
    rootEntityId: null,
    status: "active" as const,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function allow(request: PermissionRequest): PermissionDecision {
  return {
    allowed: true,
    reason: "test_authorized",
    subjectId:
      request.subject.kind === "user"
        ? request.subject.userId
        : request.subject.agentId,
    subjectKind: request.subject.kind,
    rootEntityId: request.rootEntityId,
    action: request.action,
    resourceKind: request.resourceKind,
    matchedRoles: ["role-test"],
    missingActions: [],
    constraints: {},
  };
}

const policyEngine: PolicyEngine = {
  decide: async (request) => allow(request),
};

function baseCommand(): Pick<
  MemoryWriteCommand,
  "subject" | "rootEntityId" | "branchRef" | "commit"
> {
  return {
    subject: {
      kind: "user",
      userId: "user-alice",
    },
    rootEntityId,
    branchRef: "main",
    commit: {
      id: "commit-import-conversation",
      message: "Import conversation",
    },
  };
}

test("conversation import creates only L1 history through the authorized route", async () => {
  const authority = new InMemoryMemoryAuthority({
    entities: [
      rootEntity(),
    ],
  });
  const router = new PermissionRouter(policyEngine, authority);

  await router.execute({
    ...baseCommand(),
    action: "import_resource",
    resourceKind: "resource",
    operation: {
      kind: "create_resource",
      id: "operation-create-conversation",
      resource: {
        id: "resource-conversation-1",
        rootEntityId,
        sourceType: "conversation",
        title: "Architecture discussion",
        contentHash: "sha256:conversation-v1",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      revisionId: "revision-conversation-1",
    },
  });

  await router.execute({
    ...baseCommand(),
    commit: {
      id: "commit-add-conversation-chunk",
      message: "Add conversation chunk",
    },
    action: "write_resource_chunk",
    resourceKind: "resource_chunk",
    operation: {
      kind: "create_resource_chunk",
      id: "operation-create-conversation-chunk",
      chunk: {
        id: "chunk-conversation-1",
        rootEntityId,
        resourceId: "resource-conversation-1",
        chunkIndex: 0,
        text: "RBAC and Memory remain independent modules.",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  });

  const view = authority.readActiveView(rootEntityId, "main");
  assert.equal(view.resources.length, 1);
  assert.equal(view.resourceChunks.length, 1);
  assert.equal(view.entities.length, 1);
  assert.equal(view.entityBranches.length, 0);
  assert.equal(view.relations.length, 0);
  const commits = authority.listCommits(rootEntityId, "main");
  assert.equal(commits.length, 2);
  assert.equal(
    commits[1]?.parentCommitId,
    "commit-import-conversation",
  );
  assert.equal(authority.listOperations(rootEntityId, "main").length, 2);
  assert.equal(
    authority.listBranches(rootEntityId)[0]?.headCommitId,
    "commit-add-conversation-chunk",
  );
});

test("memory authority rejects payloads outside the authorized root", async () => {
  const authority = new InMemoryMemoryAuthority();
  const router = new PermissionRouter(policyEngine, authority);

  await assert.rejects(
    () =>
      router.execute({
        ...baseCommand(),
        action: "import_resource",
        resourceKind: "resource",
        operation: {
          kind: "create_resource",
          id: "operation-cross-root",
          resource: {
            id: "resource-secret",
            rootEntityId: "root-project-b",
            sourceType: "document",
            title: "Secret",
            contentHash: "sha256:secret",
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          revisionId: "revision-secret",
        },
      }),
    /operation rootEntityId must match authorization/,
  );
});

test("structured memory is created explicitly and traces back to L1 evidence", async () => {
  const authority = new InMemoryMemoryAuthority({
    entities: [
      rootEntity(),
    ],
    resources: [
      {
        id: "resource-architecture-source",
        rootEntityId,
        sourceType: "document",
        title: "Architecture source",
        contentHash: "sha256:architecture-source",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    resourceChunks: [
      {
        id: "chunk-architecture-source",
        rootEntityId,
        resourceId: "resource-architecture-source",
        chunkIndex: 0,
        text: "The architecture keeps RBAC and Memory independent.",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  });
  const router = new PermissionRouter(policyEngine, authority);

  await router.execute({
    ...baseCommand(),
    commit: { id: "commit-create-entity" },
    action: "write_entity",
    resourceKind: "memory_entity",
    operation: {
      kind: "create_entity",
      id: "operation-create-entity",
      entity: {
        id: "entity-architecture",
        rootEntityId,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  });
  await router.execute({
    ...baseCommand(),
    commit: { id: "commit-create-entity-branch" },
    action: "write_entity_branch",
    resourceKind: "memory_entity_branch",
    operation: {
      kind: "create_entity_branch",
      id: "operation-create-entity-branch",
      branch: {
        id: "entity-branch-architecture-v1",
        entityId: "entity-architecture",
        rootEntityId,
        branchRef: "main",
        title: "Architecture",
        description: "RBAC and Memory are independent modules.",
        tags: ["architecture"],
        importance: 0.9,
        confidence: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  });
  await router.execute({
    ...baseCommand(),
    commit: { id: "commit-create-evidence-relation" },
    action: "write_relation",
    resourceKind: "memory_relation",
    operation: {
      kind: "create_relation",
      id: "operation-create-evidence-relation",
      relation: {
        id: "relation-architecture-evidence",
        rootEntityId,
        sourceId: "entity-architecture",
        sourceKind: "memory_entity",
        targetId: "chunk-architecture-source",
        targetKind: "resource_chunk",
        relationType: "refers_to",
        role: "source_chunk",
        weight: 1,
        confidence: 1,
        branchRef: "main",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  });
  await router.execute({
    ...baseCommand(),
    commit: { id: "commit-create-conflicting-branch" },
    action: "write_entity_branch",
    resourceKind: "memory_entity_branch",
    operation: {
      kind: "create_entity_branch",
      id: "operation-create-conflicting-branch",
      branch: {
        id: "entity-branch-architecture-v2",
        entityId: "entity-architecture",
        rootEntityId,
        branchRef: "main",
        parentBranchId: "entity-branch-architecture-v1",
        title: "Architecture correction",
        description: "RBAC and Memory remain separate but share gateway routing.",
        tags: ["architecture", "correction"],
        importance: 0.9,
        confidence: 0.85,
        status: "conflicted",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  });
  await router.execute({
    ...baseCommand(),
    commit: { id: "commit-create-branch-conflict-relation" },
    action: "write_relation",
    resourceKind: "memory_relation",
    operation: {
      kind: "create_relation",
      id: "operation-create-branch-conflict-relation",
      relation: {
        id: "relation-architecture-branch-conflict",
        rootEntityId,
        sourceId: "entity-branch-architecture-v2",
        sourceKind: "memory_entity_branch",
        targetId: "entity-branch-architecture-v1",
        targetKind: "memory_entity_branch",
        relationType: "contradicts",
        weight: 1,
        confidence: 0.85,
        branchRef: "main",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  });

  const view = authority.readActiveView(rootEntityId, "main");
  const entity = view.entities.find(
    (candidate) => candidate.id === "entity-architecture",
  );
  assert.equal(
    entity?.currentBranchId,
    "entity-branch-architecture-v2",
  );
  assert.ok(
    view.entityBranches.some((branch) =>
      branch.id === "entity-branch-architecture-v1"
    ),
  );
  assert.ok(
    view.entityBranches.some((branch) =>
      branch.id === "entity-branch-architecture-v2"
    ),
  );
  assert.equal(
    authority
      .listOperations(rootEntityId, "main")
      .find(({ id }) => id === "operation-create-entity-branch")?.commitId,
    "commit-create-entity-branch",
  );
  assert.equal(view.relations[0]?.relationType, "refers_to");
  assert.equal(view.relations[0]?.targetId, "chunk-architecture-source");
  assert.ok(
    view.relations.some((relation) =>
      relation.sourceKind === "memory_entity_branch" &&
      relation.targetKind === "memory_entity_branch" &&
      relation.relationType === "contradicts"
    ),
  );
});

test("resource updates append revisions without overwriting history", async () => {
  const authority = new InMemoryMemoryAuthority({
    entities: [rootEntity()],
  });
  const router = new PermissionRouter(policyEngine, authority);

  await router.execute({
    ...baseCommand(),
    commit: { id: "commit-resource-v1" },
    action: "import_resource",
    resourceKind: "resource",
    operation: {
      kind: "create_resource",
      id: "operation-resource-v1",
      resource: {
        id: "resource-design",
        rootEntityId,
        sourceType: "document",
        title: "Design",
        contentHash: "sha256:v1",
        metadata: { version: 1 },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      revisionId: "revision-design-v1",
    },
  });
  await router.execute({
    ...baseCommand(),
    commit: { id: "commit-resource-v2" },
    action: "import_resource",
    resourceKind: "resource",
    operation: {
      kind: "revise_resource",
      id: "operation-resource-v2",
      resourceId: "resource-design",
      revisionId: "revision-design-v2",
      contentHash: "sha256:v2",
      metadata: { version: 2 },
    },
  });

  const resource = authority.readActiveView(rootEntityId, "main")
    .resources[0];
  const revisions = authority.listResourceRevisions(
    rootEntityId,
    "main",
  );

  assert.equal(resource?.contentHash, "sha256:v2");
  assert.equal(resource?.currentRevisionId, "revision-design-v2");
  assert.deepEqual(
    revisions.map(({ id, contentHash, parentRevisionId }) => ({
      id,
      contentHash,
      parentRevisionId,
    })),
    [
      {
        id: "revision-design-v1",
        contentHash: "sha256:v1",
        parentRevisionId: undefined,
      },
      {
        id: "revision-design-v2",
        contentHash: "sha256:v2",
        parentRevisionId: "revision-design-v1",
      },
    ],
  );
});

test("relation replacement tombstones the old edge and creates a new edge in one commit", async () => {
  const authority = new InMemoryMemoryAuthority({
    entities: [
      rootEntity(),
      {
        id: "entity-workflow",
        rootEntityId,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "entity-step-old",
        rootEntityId,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "entity-step-new",
        rootEntityId,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    relations: [
      {
        id: "relation-old",
        rootEntityId,
        sourceId: "entity-workflow",
        sourceKind: "memory_entity",
        targetId: "entity-step-old",
        targetKind: "memory_entity",
        relationType: "has",
        role: "step",
        ordinal: 1,
        weight: 1,
        confidence: 1,
        branchRef: "main",
        commitId: "commit-seed",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  });
  const router = new PermissionRouter(policyEngine, authority);

  const result = await router.execute({
    ...baseCommand(),
    commit: { id: "commit-replace-relation" },
    action: "write_relation",
    resourceKind: "memory_relation",
    operation: {
      kind: "replace_relation",
      id: "operation-tombstone-old-relation",
      previousRelationId: "relation-old",
      replacementOperationId: "operation-create-new-relation",
      replacement: {
        id: "relation-new",
        rootEntityId,
        sourceId: "entity-workflow",
        sourceKind: "memory_entity",
        targetId: "entity-step-new",
        targetKind: "memory_entity",
        relationType: "has",
        role: "step",
        ordinal: 1,
        weight: 1,
        confidence: 1,
        branchRef: "main",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  });

  assert.equal(result.decision.allowed, true);
  if (!("value" in result)) {
    assert.fail("authorized relation replacement must return a value");
  }
  assert.deepEqual(result.value.commit.operationIds, [
    "operation-tombstone-old-relation",
    "operation-create-new-relation",
  ]);
  assert.deepEqual(
    authority
      .readActiveView(rootEntityId, "main")
      .relations.map(({ id }) => id),
    ["relation-new"],
  );
  assert.deepEqual(
    authority
      .listOperations(rootEntityId, "main")
      .map(({ kind }) => kind),
    ["tombstone_relation", "create_relation"],
  );
});

test("entity tombstone removes the entity and its relations from the active view", async () => {
  const authority = new InMemoryMemoryAuthority({
    entities: [
      rootEntity(),
      {
        id: "entity-obsolete",
        rootEntityId,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    relations: [
      {
        id: "relation-obsolete",
        rootEntityId,
        sourceId: rootEntityId,
        sourceKind: "memory_entity",
        targetId: "entity-obsolete",
        targetKind: "memory_entity",
        relationType: "has",
        weight: 1,
        confidence: 1,
        branchRef: "main",
        commitId: "commit-seed",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  });
  const router = new PermissionRouter(policyEngine, authority);

  await router.execute({
    ...baseCommand(),
    commit: { id: "commit-tombstone-entity" },
    action: "tombstone_entity",
    resourceKind: "memory_entity",
    operation: {
      kind: "tombstone_entity",
      id: "operation-tombstone-entity",
      targetId: "entity-obsolete",
    },
  });

  const view = authority.readActiveView(rootEntityId, "main");
  assert.deepEqual(
    view.entities.map(({ id }) => id),
    [rootEntityId],
  );
  assert.equal(view.relations.length, 0);
  assert.equal(authority.listOperations(rootEntityId, "main").length, 1);
});

test("revert removes a commit from the active view while preserving history", async () => {
  const authority = new InMemoryMemoryAuthority({
    entities: [
      rootEntity(),
    ],
  });
  const router = new PermissionRouter(policyEngine, authority);

  await router.execute({
    ...baseCommand(),
    commit: { id: "commit-create-wrong-entity" },
    action: "write_entity",
    resourceKind: "memory_entity",
    operation: {
      kind: "create_entity",
      id: "operation-create-wrong-entity",
      entity: {
        id: "entity-wrong",
        rootEntityId,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  });
  await router.execute({
    ...baseCommand(),
    commit: { id: "commit-revert-wrong-entity" },
    action: "revert",
    resourceKind: "memory_entity",
    operation: {
      kind: "revert_commit",
      id: "operation-revert-wrong-entity",
      targetCommitId: "commit-create-wrong-entity",
    },
  });

  assert.deepEqual(
    authority
      .readActiveView(rootEntityId, "main")
      .entities.map(({ id }) => id),
    [rootEntityId],
  );
  assert.deepEqual(
    authority
      .listCommits(rootEntityId, "main")
      .map(({ id }) => id),
    ["commit-create-wrong-entity", "commit-revert-wrong-entity"],
  );
  assert.deepEqual(
    authority
      .listOperations(rootEntityId, "main")
      .map(({ kind }) => kind),
    ["create_entity", "revert_commit"],
  );
});

test("revert rejects a commit outside the current root and branch history", async () => {
  const authority = new InMemoryMemoryAuthority({
    entities: [rootEntity()],
  });
  const router = new PermissionRouter(policyEngine, authority);

  await assert.rejects(
    () =>
      router.execute({
        ...baseCommand(),
        commit: { id: "commit-invalid-revert" },
        action: "revert",
        resourceKind: "memory_entity",
        operation: {
          kind: "revert_commit",
          id: "operation-invalid-revert",
          targetCommitId: "commit-does-not-exist",
        },
      }),
    /revert target commit not found/,
  );
});

test("failed writes do not leave partial commits or operations", async () => {
  const authority = new InMemoryMemoryAuthority({
    entities: [rootEntity()],
  });
  const router = new PermissionRouter(policyEngine, authority);

  await assert.rejects(
    () =>
      router.execute({
        ...baseCommand(),
        commit: { id: "commit-invalid-revision" },
        action: "import_resource",
        resourceKind: "resource",
        operation: {
          kind: "revise_resource",
          id: "operation-invalid-revision",
          resourceId: "resource-missing",
          revisionId: "revision-missing-v2",
          contentHash: "sha256:missing",
        },
      }),
    /resource not found/,
  );

  assert.equal(authority.listCommits(rootEntityId, "main").length, 0);
  assert.equal(authority.listOperations(rootEntityId, "main").length, 0);
});

test("writes reject broken references instead of creating orphan memory", async () => {
  const authority = new InMemoryMemoryAuthority({
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
  const router = new PermissionRouter(policyEngine, authority);

  await assert.rejects(
    () =>
      router.execute({
        ...baseCommand(),
        commit: { id: "commit-orphan-branch" },
        action: "write_entity_branch",
        resourceKind: "memory_entity_branch",
        operation: {
          kind: "create_entity_branch",
          id: "operation-orphan-branch",
          branch: {
            id: "entity-branch-orphan",
            entityId: "entity-missing",
            rootEntityId,
            branchRef: "main",
            title: "Orphan",
            description: "Must not be stored",
            tags: [],
            importance: 0,
            confidence: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        },
      }),
    /entity not found/,
  );

  assert.equal(authority.listCommits(rootEntityId, "main").length, 0);
});

test("root entities require explicit administrator actions", async () => {
  const authority = new InMemoryMemoryAuthority();
  const router = new PermissionRouter(policyEngine, authority);

  await router.execute({
    ...baseCommand(),
    commit: { id: "commit-create-root" },
    action: "create_root_entity",
    resourceKind: "memory_entity",
    operation: {
      kind: "create_entity",
      id: "operation-create-root",
      entity: {
        id: rootEntityId,
        rootEntityId: null,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  });

  assert.equal(
    authority.readActiveView(rootEntityId, "main").entities[0]
      ?.rootEntityId,
    null,
  );

  await assert.rejects(
    () =>
      router.execute({
        ...baseCommand(),
        commit: { id: "commit-create-root-as-write" },
        action: "write_entity",
        resourceKind: "memory_entity",
        operation: {
          kind: "create_entity",
          id: "operation-create-root-as-write",
          entity: {
            id: "root-project-b",
            rootEntityId: null,
            status: "active",
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        },
      }),
    /create_entity requires create_root_entity/,
  );
});

test("deleting a root entity removes its entire active view", async () => {
  const authority = new InMemoryMemoryAuthority({
    entities: [
      rootEntity(),
      {
        id: "entity-child",
        rootEntityId,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    resources: [
      {
        id: "resource-child",
        rootEntityId,
        sourceType: "document",
        title: "Child",
        contentHash: "sha256:child",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  });
  const router = new PermissionRouter(policyEngine, authority);

  await router.execute({
    ...baseCommand(),
    commit: { id: "commit-delete-root" },
    action: "delete_root_entity",
    resourceKind: "memory_entity",
    operation: {
      kind: "tombstone_entity",
      id: "operation-delete-root",
      targetId: rootEntityId,
    },
  });

  const view = authority.readActiveView(rootEntityId, "main");
  assert.equal(view.entities.length, 0);
  assert.equal(view.resources.length, 0);

  await router.execute({
    ...baseCommand(),
    commit: { id: "commit-restore-root" },
    action: "revert",
    resourceKind: "memory_entity",
    operation: {
      kind: "revert_commit",
      id: "operation-restore-root",
      targetCommitId: "commit-delete-root",
    },
  });

  const restored = authority.readActiveView(rootEntityId, "main");
  assert.equal(restored.entities.length, 2);
  assert.equal(restored.resources.length, 1);
});

test("read-only RBAC decisions never reach the memory write authority", async () => {
  const authority = new InMemoryMemoryAuthority({
    entities: [rootEntity()],
  });
  const engine = new ScopedPolicyEngine(
    new InMemoryRbacAuthority({
      users: [contractFixtures.user],
      roles: [contractFixtures.researcherRole],
      assignments: [contractFixtures.assignment],
    }),
  );
  const router = new PermissionRouter(engine, authority);

  const result = await router.execute({
    ...baseCommand(),
    commit: { id: "commit-denied-write" },
    action: "write_entity",
    resourceKind: "memory_entity",
    operation: {
      kind: "create_entity",
      id: "operation-denied-write",
      entity: {
        id: "entity-must-not-exist",
        rootEntityId,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  });

  assert.equal(result.decision.allowed, false);
  assert.equal(authority.listCommits(rootEntityId, "main").length, 0);
});
