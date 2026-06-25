import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentDelegation,
  PermissionDecision,
  PermissionRequest,
  PolicyEngine,
} from "../src/contracts/rbac.ts";
import {
  InMemoryAgentSessionAuthority,
  permissionRequestFromPrincipal,
  provenanceFromPrincipal,
} from "../src/agent/index.ts";
import { InMemoryMemoryAuthority } from "../src/memory/index.ts";
import { PermissionRouter } from "../src/permission-router.ts";
import { InMemoryRbacAuthority } from "../src/rbac/index.ts";

const timestamp = "2026-06-25T00:00:00.000Z";
const later = "2026-06-26T00:00:00.000Z";
const rootEntityId = "root-project-a";

function delegation(): AgentDelegation {
  return {
    id: "delegation-agent",
    agentId: "agent-main",
    ownerUserId: "user-alice",
    rootEntityId,
    permissions: [
      {
        action: "write_entity",
        resourceKind: "memory_entity",
      },
    ],
    delegatedBy: "user-alice",
    delegatedAt: timestamp,
    status: "active",
    expiresAt: later,
  };
}

function rbac() {
  return new InMemoryRbacAuthority({
    users: [
      {
        id: "user-alice",
        displayName: "Alice",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "user-mallory",
        displayName: "Mallory",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    agents: [
      {
        id: "agent-main",
        ownerUserId: "user-alice",
        agentType: "main_agent",
        displayName: "Main",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    delegations: [delegation()],
  });
}

test("trusted session resolves PrincipalContext without model-supplied user identity", async () => {
  const authority = rbac();
  let id = 0;
  const sessions = new InMemoryAgentSessionAuthority(authority, {
    now: () => new Date(timestamp),
    randomId: () => `random-${++id}`,
  });
  const session = await sessions.create({
    userId: "user-alice",
    agentId: "agent-main",
    rootEntityId,
    taskScope: {
      rootEntityId,
      allowedEntityIds: ["entity-a"],
    },
    delegationId: "delegation-agent",
    expiresAt: later,
  });

  const principal = await sessions.resolve(session.token);
  assert.deepEqual(principal, {
    sessionId: "session:random-1",
    userId: "user-alice",
    agentId: "agent-main",
    rootEntityId,
    taskScope: {
      rootEntityId,
      allowedEntityIds: ["entity-a"],
    },
    delegationId: "delegation-agent",
  });
  const request = permissionRequestFromPrincipal(principal, {
    action: "write_entity",
    resourceKind: "memory_entity",
    entityId: "entity-a",
  });
  assert.deepEqual(request.subject, {
    kind: "agent",
    agentId: "agent-main",
    ownerUserId: "user-alice",
  });
  assert.equal(request.rootEntityId, rootEntityId);
});

test("forged identity, cross-root overrides, expiry, and lifecycle revocation are rejected", async () => {
  const authority = rbac();
  let now = new Date(timestamp);
  let id = 0;
  const sessions = new InMemoryAgentSessionAuthority(authority, {
    now: () => now,
    randomId: () => `random-${++id}`,
  });

  await assert.rejects(
    () =>
      sessions.create({
        userId: "user-mallory",
        agentId: "agent-main",
        rootEntityId,
        taskScope: { rootEntityId },
        delegationId: "delegation-agent",
        expiresAt: later,
      }),
    /does not belong/,
  );
  const session = await sessions.create({
    userId: "user-alice",
    agentId: "agent-main",
    rootEntityId,
    taskScope: { rootEntityId },
    delegationId: "delegation-agent",
    expiresAt: later,
  });
  await assert.rejects(
    () => sessions.resolve("agent-session:forged"),
    /invalid agent session/,
  );
  const principal = await sessions.resolve(session.token);
  assert.throws(
    () =>
      permissionRequestFromPrincipal(principal, {
        action: "read",
        resourceKind: "memory_entity",
        rootEntityId: "root-project-b",
      } as never),
    /cannot override rootEntityId/,
  );

  authority.revokeDelegation("delegation-agent", timestamp);
  await assert.rejects(
    () => sessions.resolve(session.token),
    /delegation is inactive/,
  );

  const activeAuthority = rbac();
  const expiring = new InMemoryAgentSessionAuthority(activeAuthority, {
    now: () => now,
    randomId: () => `expiry-${++id}`,
  });
  const expiringSession = await expiring.create({
    userId: "user-alice",
    agentId: "agent-main",
    rootEntityId,
    taskScope: { rootEntityId },
    delegationId: "delegation-agent",
    expiresAt: later,
  });
  now = new Date(later);
  await assert.rejects(
    () => expiring.resolve(expiringSession.token),
    /session expired/,
  );

  now = new Date(timestamp);
  const disabledSessions = new InMemoryAgentSessionAuthority(
    activeAuthority,
    {
      now: () => now,
      randomId: () => `disabled-${++id}`,
    },
  );
  const disabledSession = await disabledSessions.create({
    userId: "user-alice",
    agentId: "agent-main",
    rootEntityId,
    taskScope: { rootEntityId },
    delegationId: "delegation-agent",
    expiresAt: later,
  });
  activeAuthority.setAgentStatus("agent-main", "disabled");
  await assert.rejects(
    () => disabledSessions.resolve(disabledSession.token),
    /does not belong/,
  );

  const userAuthority = rbac();
  const userSessions = new InMemoryAgentSessionAuthority(userAuthority, {
    now: () => new Date(timestamp),
    randomId: () => `user-disabled-${++id}`,
  });
  const userSession = await userSessions.create({
    userId: "user-alice",
    agentId: "agent-main",
    rootEntityId,
    taskScope: { rootEntityId },
    delegationId: "delegation-agent",
    expiresAt: later,
  });
  userAuthority.setUserStatus("user-alice", "disabled");
  await assert.rejects(
    () => userSessions.resolve(userSession.token),
    /user is inactive/,
  );
});

test("agent memory operations retain session, owner, and delegation provenance", async () => {
  const authority = rbac();
  let id = 0;
  const sessions = new InMemoryAgentSessionAuthority(authority, {
    now: () => new Date(timestamp),
    randomId: () => `audit-${++id}`,
  });
  const session = await sessions.create({
    userId: "user-alice",
    agentId: "agent-main",
    rootEntityId,
    taskScope: { rootEntityId },
    delegationId: "delegation-agent",
    expiresAt: later,
  });
  const principal = await sessions.resolve(session.token);
  const memory = new InMemoryMemoryAuthority({
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
  const policy: PolicyEngine = {
    decide: async (request: PermissionRequest): Promise<PermissionDecision> => ({
      allowed: true,
      reason: "test",
      subjectId: "agent-main",
      subjectKind: "agent",
      rootEntityId: request.rootEntityId,
      action: request.action,
      resourceKind: request.resourceKind,
      matchedRoles: ["role-curator"],
      missingActions: [],
      constraints: {},
    }),
  };
  const router = new PermissionRouter(policy, memory);
  await router.execute({
    ...permissionRequestFromPrincipal(principal, {
      action: "write_entity",
      resourceKind: "memory_entity",
    }),
    branchRef: "main",
    commit: { id: "commit-agent-write" },
    provenance: provenanceFromPrincipal(principal),
    operation: {
      kind: "create_entity",
      id: "operation-agent-write",
      entity: {
        id: "entity-agent",
        rootEntityId,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  });

  assert.deepEqual(
    memory.listOperations(rootEntityId, "main")[0]?.provenance,
    {
      sessionId: "session:audit-1",
      ownerUserId: "user-alice",
      delegationId: "delegation-agent",
    },
  );
});
