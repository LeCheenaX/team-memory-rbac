import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentDelegation,
  PermissionAuditLog,
  PermissionDecision,
  PermissionDecisionCache,
  PermissionRequest,
  Role,
  UserRootRoleAssignment,
} from "../src/contracts/rbac.ts";
import {
  BUILT_IN_ROLES,
  InMemoryRbacAuthority,
  ScopedPolicyEngine,
} from "../src/rbac/index.ts";
import { contractFixtures } from "./support/contract-fixtures.ts";

const now = new Date("2026-06-25T12:00:00.000Z");

function assignment(
  id: string,
  rootEntityId: string,
  roleId: string,
  overrides: Partial<UserRootRoleAssignment> = {},
): UserRootRoleAssignment {
  return {
    id,
    userId: contractFixtures.user.id,
    rootEntityId,
    roleId,
    assignedBy: "user-admin",
    assignedAt: "2026-06-25T00:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

test("user permissions are the union of active roles at one root only", async () => {
  const writerRole: Role = {
    id: "role-writer",
    name: "writer",
    kind: "custom",
    status: "active",
    permissions: [
      {
        action: "write_entity",
        resourceKind: "memory_entity",
      },
      {
        action: "traverse_relation",
        resourceKind: "memory_relation",
      },
    ],
  };
  const authority = new InMemoryRbacAuthority({
    users: [contractFixtures.user],
    roles: [contractFixtures.researcherRole, writerRole],
    assignments: [
      assignment(
        "assignment-research",
        "root-project-a",
        contractFixtures.researcherRole.id,
      ),
      assignment("assignment-writer", "root-project-a", writerRole.id),
      assignment(
        "assignment-expired-writer",
        "root-project-b",
        writerRole.id,
        { expiresAt: "2026-06-25T11:59:59.000Z" },
      ),
    ],
  });
  const engine = new ScopedPolicyEngine(authority, {
    now: () => now,
  });

  const allowed = await engine.decide({
    subject: {
      kind: "user",
      userId: contractFixtures.user.id,
    },
    rootEntityId: "root-project-a",
    action: "write_entity",
    resourceKind: "memory_entity",
  });
  const deniedAtOtherRoot = await engine.decide({
    subject: {
      kind: "user",
      userId: contractFixtures.user.id,
    },
    rootEntityId: "root-project-b",
    action: "write_entity",
    resourceKind: "memory_entity",
  });

  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.matchedRoles, ["role-writer"]);
  assert.equal(deniedAtOtherRoot.allowed, false);
  assert.equal(deniedAtOtherRoot.reason, "missing_permission");
  assert.deepEqual(deniedAtOtherRoot.missingActions, ["write_entity"]);
});

test("agent permissions intersect owner roles, delegation, and task scope", async () => {
  const writerRole: Role = {
    id: "role-writer",
    name: "writer",
    kind: "custom",
    status: "active",
    permissions: [
      {
        action: "read",
        resourceKind: "memory_entity",
      },
      {
        action: "traverse_relation",
        resourceKind: "memory_relation",
      },
      {
        action: "write_entity",
        resourceKind: "memory_entity",
      },
    ],
  };
  const delegation: AgentDelegation = {
    id: "delegation-read-architecture",
    agentId: contractFixtures.agent.id,
    ownerUserId: contractFixtures.user.id,
    rootEntityId: "root-project-a",
    permissions: [
      {
        action: "read",
        resourceKind: "memory_entity",
      },
    ],
    constraints: {
      allowedTags: ["architecture", "security"],
    },
    delegatedBy: contractFixtures.user.id,
    delegatedAt: "2026-06-25T00:00:00.000Z",
    status: "active",
  };
  const engine = new ScopedPolicyEngine(
    new InMemoryRbacAuthority({
      users: [contractFixtures.user],
      agents: [contractFixtures.agent],
      roles: [writerRole],
      assignments: [
        assignment("assignment-writer", "root-project-a", writerRole.id),
      ],
      delegations: [delegation],
    }),
    { now: () => now },
  );

  const allowed = await engine.decide({
    subject: {
      kind: "agent",
      agentId: contractFixtures.agent.id,
      ownerUserId: contractFixtures.user.id,
    },
    rootEntityId: "root-project-a",
    action: "read",
    resourceKind: "memory_entity",
    entityId: "entity-architecture",
    tags: ["architecture"],
    taskScope: {
      rootEntityId: "root-project-a",
      allowedEntityIds: ["entity-architecture"],
      allowedTags: ["architecture"],
    },
  });
  const deniedWrite = await engine.decide({
    subject: {
      kind: "agent",
      agentId: contractFixtures.agent.id,
      ownerUserId: contractFixtures.user.id,
    },
    rootEntityId: "root-project-a",
    action: "write_entity",
    resourceKind: "memory_entity",
    taskScope: {
      rootEntityId: "root-project-a",
    },
  });
  const deniedTag = await engine.decide({
    subject: {
      kind: "agent",
      agentId: contractFixtures.agent.id,
      ownerUserId: contractFixtures.user.id,
    },
    rootEntityId: "root-project-a",
    action: "read",
    resourceKind: "memory_entity",
    tags: ["finance"],
    taskScope: {
      rootEntityId: "root-project-a",
      allowedTags: ["architecture"],
    },
  });
  const deniedRelationDepth = await engine.decide({
    subject: {
      kind: "agent",
      agentId: contractFixtures.agent.id,
      ownerUserId: contractFixtures.user.id,
    },
    rootEntityId: "root-project-a",
    action: "traverse_relation",
    resourceKind: "memory_relation",
    relationType: "has",
    relationDepth: 2,
    taskScope: {
      rootEntityId: "root-project-a",
      relationExpansionPolicy: {
        allowedRelationTypes: ["has"],
        maxDepth: 1,
      },
    },
  });

  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.constraints.allowedTags, ["architecture"]);
  assert.equal(deniedWrite.reason, "missing_delegation");
  assert.equal(deniedTag.reason, "outside_task_scope");
  assert.equal(deniedRelationDepth.reason, "outside_task_scope");
});

test("agents cannot execute administrator actions even when the owner can", async () => {
  const adminRole: Role = {
    id: "role-test-admin",
    name: "test_admin",
    kind: "custom",
    status: "active",
    permissions: [
      {
        action: "create_root_entity",
        resourceKind: "memory_entity",
        constraints: {
          allowRootEntityMutation: true,
        },
      },
    ],
  };
  const engine = new ScopedPolicyEngine(
    new InMemoryRbacAuthority({
      users: [contractFixtures.user],
      agents: [contractFixtures.agent],
      roles: [adminRole],
      assignments: [
        assignment("assignment-admin", "root-project-a", adminRole.id),
      ],
      delegations: [
        {
          id: "delegation-admin",
          agentId: contractFixtures.agent.id,
          ownerUserId: contractFixtures.user.id,
          rootEntityId: "root-project-a",
          permissions: adminRole.permissions,
          delegatedBy: contractFixtures.user.id,
          delegatedAt: "2026-06-25T00:00:00.000Z",
          status: "active",
        },
      ],
    }),
    { now: () => now },
  );

  const result = await engine.decide({
    subject: {
      kind: "agent",
      agentId: contractFixtures.agent.id,
      ownerUserId: contractFixtures.user.id,
    },
    rootEntityId: "root-project-a",
    action: "create_root_entity",
    resourceKind: "memory_entity",
    taskScope: {
      rootEntityId: "root-project-a",
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "agent_admin_action_forbidden");
});

test("policy decisions use the cache while every request remains audited", async () => {
  const requests: PermissionRequest[] = [];
  const decisions = new Map<string, PermissionDecision>();
  const cache: PermissionDecisionCache = {
    get: async (request) => decisions.get(JSON.stringify(request)),
    set: async (request, result) => {
      decisions.set(JSON.stringify(request), result);
    },
    invalidateSubjectAtRoot: async () => {
      decisions.clear();
    },
  };
  const auditLog: PermissionAuditLog = {
    record: async (request) => {
      requests.push(request);
    },
  };
  const engine = new ScopedPolicyEngine(
    new InMemoryRbacAuthority({
      users: [contractFixtures.user],
      roles: [contractFixtures.researcherRole],
      assignments: [
        assignment(
          "assignment-research",
          "root-project-a",
          contractFixtures.researcherRole.id,
        ),
      ],
    }),
    {
      now: () => now,
      cache,
      auditLog,
    },
  );
  const request: PermissionRequest = {
    subject: {
      kind: "user",
      userId: contractFixtures.user.id,
    },
    rootEntityId: "root-project-a",
    action: "search",
    resourceKind: "memory_entity",
  };

  const first = await engine.decide(request);
  const second = await engine.decide(request);

  assert.deepEqual(second, first);
  assert.equal(decisions.size, 1);
  assert.equal(requests.length, 2);
});

test("user requests also honor task scope and union alternative role grants", async () => {
  const architectureRole: Role = {
    id: "role-architecture-reader",
    name: "architecture_reader",
    kind: "custom",
    status: "active",
    permissions: [
      {
        action: "read",
        resourceKind: "memory_entity",
        constraints: {
          allowedTags: ["architecture"],
        },
      },
    ],
  };
  const securityRole: Role = {
    id: "role-security-reader",
    name: "security_reader",
    kind: "custom",
    status: "active",
    permissions: [
      {
        action: "read",
        resourceKind: "memory_entity",
        constraints: {
          allowedTags: ["security"],
        },
      },
    ],
  };
  const engine = new ScopedPolicyEngine(
    new InMemoryRbacAuthority({
      users: [contractFixtures.user],
      roles: [architectureRole, securityRole],
      assignments: [
        assignment(
          "assignment-architecture",
          "root-project-a",
          architectureRole.id,
        ),
        assignment(
          "assignment-security",
          "root-project-a",
          securityRole.id,
        ),
      ],
    }),
    { now: () => now },
  );

  const broadDecision = await engine.decide({
    subject: {
      kind: "user",
      userId: contractFixtures.user.id,
    },
    rootEntityId: "root-project-a",
    action: "read",
    resourceKind: "memory_entity",
  });
  const scopedDenial = await engine.decide({
    subject: {
      kind: "user",
      userId: contractFixtures.user.id,
    },
    rootEntityId: "root-project-a",
    action: "read",
    resourceKind: "memory_entity",
    tags: ["security"],
    taskScope: {
      rootEntityId: "root-project-a",
      allowedTags: ["architecture"],
    },
  });

  assert.deepEqual(broadDecision.constraints.allowedTags, [
    "architecture",
    "security",
  ]);
  assert.equal(scopedDenial.allowed, false);
  assert.equal(scopedDenial.reason, "outside_task_scope");
});

test("built-in agent responsibilities receive only their delegated capability", async () => {
  const roleById = new Map(BUILT_IN_ROLES.map((role) => [role.id, role]));
  const researcher = roleById.get("role-researcher");
  const curator = roleById.get("role-curator");
  const importer = roleById.get("role-resource-importer");
  const maintainer = roleById.get("role-maintainer");
  assert.ok(researcher);
  assert.ok(curator);
  assert.ok(importer);
  assert.ok(maintainer);

  const agents = [
    {
      ...contractFixtures.agent,
      id: "agent-research",
      agentType: "sub_agent" as const,
    },
    {
      ...contractFixtures.agent,
      id: "agent-curator",
      agentType: "curator_agent" as const,
    },
    {
      ...contractFixtures.agent,
      id: "agent-importer",
      agentType: "import_agent" as const,
    },
    {
      ...contractFixtures.agent,
      id: "agent-maintainer",
      agentType: "main_agent" as const,
    },
  ];
  const capabilities = [
    {
      agentId: "agent-research",
      role: researcher,
      action: "read" as const,
      resourceKind: "memory_entity" as const,
    },
    {
      agentId: "agent-curator",
      role: curator,
      action: "write_entity_branch" as const,
      resourceKind: "memory_entity_branch" as const,
    },
    {
      agentId: "agent-importer",
      role: importer,
      action: "import_resource" as const,
      resourceKind: "resource" as const,
    },
    {
      agentId: "agent-maintainer",
      role: maintainer,
      action: "merge" as const,
      resourceKind: "memory_entity" as const,
    },
  ];
  const authority = new InMemoryRbacAuthority({
    users: [contractFixtures.user],
    agents,
    roles: [researcher, curator, importer, maintainer],
    assignments: capabilities.map(({ role }, index) =>
      assignment(
        `assignment-built-in-${index}`,
        "root-project-a",
        role.id,
      ),
    ),
    delegations: capabilities.map(
      ({ agentId, role, action, resourceKind }, index) => {
        const permission = role.permissions.find(
          (candidate) =>
            candidate.action === action &&
            candidate.resourceKind === resourceKind,
        );
        assert.ok(permission);
        return {
          id: `delegation-built-in-${index}`,
          agentId,
          ownerUserId: contractFixtures.user.id,
          rootEntityId: "root-project-a",
          permissions: [permission],
          delegatedBy: contractFixtures.user.id,
          delegatedAt: "2026-06-25T00:00:00.000Z",
          status: "active" as const,
        };
      },
    ),
  });
  const engine = new ScopedPolicyEngine(authority, { now: () => now });

  for (const capability of capabilities) {
    const result = await engine.decide({
      subject: {
        kind: "agent",
        agentId: capability.agentId,
        ownerUserId: contractFixtures.user.id,
      },
      rootEntityId: "root-project-a",
      action: capability.action,
      resourceKind: capability.resourceKind,
      taskScope: {
        rootEntityId: "root-project-a",
      },
    });
    assert.equal(
      result.allowed,
      true,
      `${capability.agentId} should receive ${capability.action}`,
    );
  }

  const researchWrite = await engine.decide({
    subject: {
      kind: "agent",
      agentId: "agent-research",
      ownerUserId: contractFixtures.user.id,
    },
    rootEntityId: "root-project-a",
    action: "write_entity",
    resourceKind: "memory_entity",
    taskScope: {
      rootEntityId: "root-project-a",
    },
  });
  assert.equal(researchWrite.allowed, false);
});
