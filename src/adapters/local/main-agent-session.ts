import { randomUUID } from "node:crypto";
import type { Permission } from "../../contracts/rbac.ts";
import { ADMIN_MEMORY_ACTIONS } from "../../contracts/rbac.ts";
import type { TeamMemoryRuntime } from "../runtime/development-stack.ts";
import type { StoredTeamMemorySession } from "./session-store.ts";

export interface MainAgentSession {
  agentId: string;
  delegationId: string;
  sessionId: string;
  token: string;
}

function activeAt(
  record: { status: "active" | "revoked"; expiresAt?: string },
  timestamp: string,
): boolean {
  return (
    record.status === "active" &&
    (record.expiresAt === undefined ||
      new Date(record.expiresAt).getTime() > new Date(timestamp).getTime())
  );
}

async function effectiveNonAdminPermissions(
  runtime: TeamMemoryRuntime,
  userId: string,
  rootEntityId: string,
  timestamp: string,
): Promise<Permission[]> {
  const adminActions = new Set<string>(ADMIN_MEMORY_ACTIONS);
  const assignments = await runtime.rbac.listUserRootRoleAssignments(
    userId,
    rootEntityId,
  );
  const roles = await Promise.all(
    assignments
      .filter((assignment) => activeAt(assignment, timestamp))
      .map((assignment) => runtime.rbac.getRole(assignment.roleId)),
  );
  return roles
    .filter((role) => role?.status === "active")
    .flatMap((role) => role?.permissions ?? [])
    .filter((permission) => !adminActions.has(permission.action));
}

export async function createMainAgentSession(
  runtime: TeamMemoryRuntime,
  input: {
    userId: string;
    rootEntityId: string;
    expiresAt: string;
    now?: string;
  },
): Promise<MainAgentSession> {
  const timestamp = input.now ?? new Date().toISOString();
  const agentId = `agent:main:${input.userId}`;
  const delegationId = `delegation:main:${input.userId}:${input.rootEntityId}`;
  const sessionId = `session:main-agent:${randomUUID()}`;

  await runtime.rbac.saveAgent({
    id: agentId,
    ownerUserId: input.userId,
    agentType: "main_agent",
    displayName: `Main agent for ${input.userId}`,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await runtime.rbac.saveDelegation({
    id: delegationId,
    agentId,
    ownerUserId: input.userId,
    rootEntityId: input.rootEntityId,
    permissions: await effectiveNonAdminPermissions(
      runtime,
      input.userId,
      input.rootEntityId,
      timestamp,
    ),
    delegatedBy: input.userId,
    delegatedAt: timestamp,
    status: "active",
    expiresAt: input.expiresAt,
  });
  const session = await runtime.rbac.createSession({
    id: sessionId,
    userId: input.userId,
    agentId,
    delegationId,
    rootEntityId: input.rootEntityId,
    taskScope: { rootEntityId: input.rootEntityId },
    expiresAt: input.expiresAt,
    createdAt: timestamp,
  });
  return {
    agentId,
    delegationId,
    sessionId,
    token: session.token,
  };
}

export async function revokeStoredMainAgentSession(
  runtime: TeamMemoryRuntime,
  storedSession: StoredTeamMemorySession | undefined,
  revokedAt: string = new Date().toISOString(),
): Promise<void> {
  if (storedSession?.agentSessionId !== undefined) {
    await runtime.rbac.revokeSession(storedSession.agentSessionId, revokedAt);
  }
}
