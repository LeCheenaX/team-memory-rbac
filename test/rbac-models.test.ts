import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILT_IN_ROLES,
  validateAgentDelegation,
  validateCustomRole,
} from "../src/rbac/index.ts";
import type {
  AgentDelegation,
  Permission,
  Role,
} from "../src/contracts/rbac.ts";

test("built-in roles expose the initial responsibility catalog", () => {
  assert.deepEqual(
    BUILT_IN_ROLES.map((role) => role.id),
    [
      "role-researcher",
      "role-curator",
      "role-resource-importer",
      "role-maintainer",
      "role-root-admin",
    ],
  );

  const researcher = BUILT_IN_ROLES[0];
  assert.ok(researcher);
  assert.equal(
    researcher.permissions.some((permission) =>
      permission.action.startsWith("write_"),
    ),
    false,
  );

  const curator = BUILT_IN_ROLES[1];
  const importer = BUILT_IN_ROLES[2];
  const maintainer = BUILT_IN_ROLES[3];
  assert.ok(curator);
  assert.ok(importer);
  assert.ok(maintainer);
  assert.equal(
    curator.permissions.some(
      ({ action }) => action === "write_entity_branch",
    ),
    true,
  );
  assert.equal(
    importer.permissions.some(
      ({ action, resourceKind }) =>
        action === "import_resource" && resourceKind === "resource",
    ),
    true,
  );
  assert.equal(
    maintainer.permissions.some(({ action }) => action === "merge"),
    true,
  );
});

test("custom roles reject duplicate permissions and invalid constraints", () => {
  const duplicatePermission: Permission = {
    action: "search",
    resourceKind: "memory_entity",
  };
  const role: Role = {
    id: "role-custom-research",
    name: "custom-research",
    kind: "custom",
    status: "active",
    permissions: [duplicatePermission, duplicatePermission],
  };

  assert.throws(() => validateCustomRole(role), /duplicate permission/);
  assert.throws(
    () =>
      validateCustomRole({
        ...role,
        permissions: [
          {
            action: "traverse_relation",
            resourceKind: "memory_relation",
            constraints: {
              maxRelationExpansionDepth: -1,
            },
          },
        ],
      }),
    /maxRelationExpansionDepth/,
  );
  assert.throws(
    () =>
      validateCustomRole({
        ...role,
        permissions: [
          {
            action: "write_entity",
            resourceKind: "memory_relation",
          },
        ],
      }),
    /unsupported permission combination/,
  );
});

test("agent delegation must remain a subset of owner permissions", () => {
  const ownerPermissions: Permission[] = [
    {
      action: "read",
      resourceKind: "memory_entity",
    },
  ];
  const delegation: AgentDelegation = {
    id: "delegation-research",
    agentId: "agent-research",
    ownerUserId: "user-alice",
    rootEntityId: "root-project-a",
    permissions: [
      {
        action: "write_entity",
        resourceKind: "memory_entity",
      },
    ],
    delegatedBy: "user-alice",
    delegatedAt: "2026-06-25T00:00:00.000Z",
    status: "active",
  };

  assert.throws(
    () => validateAgentDelegation(delegation, ownerPermissions),
    /exceeds owner permission/,
  );
});
