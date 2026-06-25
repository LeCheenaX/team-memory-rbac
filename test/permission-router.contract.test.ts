import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_MEMORY_ACTIONS,
  isAdminMemoryAction,
  type PermissionDecision,
  type PermissionRequest,
} from "../src/contracts/rbac.ts";
import { PermissionRouter } from "../src/permission-router.ts";

const request: PermissionRequest = {
  subject: {
    kind: "agent",
    agentId: "agent-research",
    ownerUserId: "user-alice",
  },
  rootEntityId: "root-project-a",
  action: "search",
  resourceKind: "memory_entity",
  branchRef: "main",
  taskScope: {
    rootEntityId: "root-project-a",
    allowedTags: ["architecture"],
  },
};

function decision(allowed: boolean): PermissionDecision {
  return {
    allowed,
    reason: allowed ? "allowed_by_role" : "missing_permission",
    subjectId: "agent-research",
    subjectKind: "agent",
    rootEntityId: "root-project-a",
    action: "search",
    resourceKind: "memory_entity",
    matchedRoles: allowed ? ["researcher"] : [],
    missingActions: allowed ? [] : ["search"],
    constraints: {},
  };
}

test("permission router forwards only authorized requests to memory", async () => {
  const received: unknown[] = [];
  const router = new PermissionRouter(
    {
      decide: async () => decision(true),
    },
    {
      execute: async (authorizedRequest) => {
        received.push(authorizedRequest);
        return { ids: ["entity-architecture"] };
      },
    },
  );

  const result = await router.execute(request);

  assert.equal(result.decision.allowed, true);
  assert.deepEqual(result.value, { ids: ["entity-architecture"] });
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], {
    ...request,
    authorization: decision(true),
  });
});

test("permission router does not forward denied requests", async () => {
  let memoryCalls = 0;
  const router = new PermissionRouter(
    {
      decide: async () => decision(false),
    },
    {
      execute: async () => {
        memoryCalls += 1;
        return {};
      },
    },
  );

  const result = await router.execute(request);

  assert.deepEqual(result, { decision: decision(false) });
  assert.equal(memoryCalls, 0);
});

test("administrator actions are explicitly classified", () => {
  assert.deepEqual(ADMIN_MEMORY_ACTIONS, [
    "assign_user_role",
    "revoke_user_role",
    "create_root_entity",
    "delete_root_entity",
  ]);
  assert.equal(isAdminMemoryAction("create_root_entity"), true);
  assert.equal(isAdminMemoryAction("write_entity"), false);
});
