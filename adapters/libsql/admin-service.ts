import { randomUUID } from "node:crypto";
import type { AgentDelegation, Permission, UserRootRoleAssignment } from "../../src/contracts/rbac.ts";
import type { PolicyEngine } from "../../src/contracts/rbac.ts";
import { validateAgentDelegation } from "../../src/rbac/validation.ts";
import { LibsqlRbacAuthority, type AuthenticatedSession } from "./rbac-authority.ts";

function now(): string { return new Date().toISOString(); }

/** Protected server-side RBAC mutations. No method accepts a client subject. */
export class PersistentRbacAdminService {
  private readonly authority: LibsqlRbacAuthority;
  private readonly policy: PolicyEngine;
  private readonly clock: () => string;

  constructor(
    authority: LibsqlRbacAuthority,
    policy: PolicyEngine,
    clock: () => string = now,
  ) { this.authority = authority; this.policy = policy; this.clock = clock; }

  async assignRole(session: AuthenticatedSession, input: Omit<UserRootRoleAssignment, "assignedBy" | "assignedAt" | "status">): Promise<UserRootRoleAssignment> {
    await this.requireHumanAdmin(session, "assign_user_role");
    if (input.rootEntityId !== session.rootEntityId) throw new Error("cross-root role assignment is forbidden");
    const assignment: UserRootRoleAssignment = { ...input, assignedBy: session.userId, assignedAt: this.clock(), status: "active" };
    await this.authority.saveAssignment(assignment);
    await this.audit(session, "assign_user_role", { assignmentId: assignment.id, userId: assignment.userId, roleId: assignment.roleId });
    return assignment;
  }

  async revokeRole(session: AuthenticatedSession, input: { assignmentId: string; userId: string }): Promise<void> {
    await this.requireHumanAdmin(session, "revoke_user_role");
    const assignment = (await this.authority.listUserRootRoleAssignments(input.userId, session.rootEntityId)).find((candidate) => candidate.id === input.assignmentId);
    if (assignment === undefined) throw new Error("role assignment not found in this root");
    await this.authority.revokeAssignment(assignment.id, this.clock());
    await this.audit(session, "revoke_user_role", { assignmentId: assignment.id, userId: assignment.userId });
  }

  async createDelegation(session: AuthenticatedSession, input: Omit<AgentDelegation, "ownerUserId" | "delegatedBy" | "delegatedAt" | "status">): Promise<AgentDelegation> {
    await this.requireHumanAdmin(session, "assign_user_role");
    if (input.rootEntityId !== session.rootEntityId) throw new Error("cross-root delegation is forbidden");
    const ownerPermissions = await this.ownerPermissions(session.userId, session.rootEntityId);
    const delegation: AgentDelegation = { ...input, ownerUserId: session.userId, delegatedBy: session.userId, delegatedAt: this.clock(), status: "active" };
    validateAgentDelegation(delegation, ownerPermissions);
    await this.authority.saveDelegation(delegation);
    await this.audit(session, "create_delegation", { delegationId: delegation.id, agentId: delegation.agentId });
    return delegation;
  }

  async revokeDelegation(session: AuthenticatedSession, input: { delegationId: string; agentId: string }): Promise<void> {
    await this.requireHumanAdmin(session, "revoke_user_role");
    const delegation = (await this.authority.listAgentDelegations(input.agentId, session.rootEntityId)).find((candidate) => candidate.id === input.delegationId);
    if (delegation === undefined) throw new Error("delegation not found in this root");
    await this.authority.revokeDelegation(delegation.id, this.clock());
    await this.audit(session, "revoke_delegation", { delegationId: delegation.id, agentId: delegation.agentId });
  }

  private async requireHumanAdmin(session: AuthenticatedSession, action: "assign_user_role" | "revoke_user_role"): Promise<void> {
    if (session.subject.kind !== "user") throw new Error("agents cannot perform administrator actions");
    const decision = await this.policy.decide({ subject: session.subject, rootEntityId: session.rootEntityId, action, resourceKind: "memory_entity" });
    if (!decision.allowed) throw new Error(`administrator permission required: ${decision.reason}`);
  }

  private async ownerPermissions(userId: string, rootEntityId: string): Promise<Permission[]> {
    const assignments = await this.authority.listUserRootRoleAssignments(userId, rootEntityId);
    const roles = await Promise.all(assignments.filter((assignment) => assignment.status === "active").map((assignment) => this.authority.getRole(assignment.roleId)));
    return roles.flatMap((role) => role?.permissions ?? []);
  }

  private audit(session: AuthenticatedSession, action: string, payload: Record<string, unknown>): Promise<void> {
    return this.authority.appendAudit({ id: `audit:${randomUUID()}`, rootEntityId: session.rootEntityId, actorUserId: session.userId, action, payload, createdAt: this.clock() });
  }
}
