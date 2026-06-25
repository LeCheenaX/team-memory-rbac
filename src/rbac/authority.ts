import type {
  AgentDelegation,
  AgentIdentity,
  RbacAuthority,
  Role,
  User,
  UserRootRoleAssignment,
} from "../contracts/rbac.ts";

export interface InMemoryRbacAuthorityData {
  users?: User[];
  agents?: AgentIdentity[];
  roles?: Role[];
  assignments?: UserRootRoleAssignment[];
  delegations?: AgentDelegation[];
}

export class InMemoryRbacAuthority implements RbacAuthority {
  private readonly users: Map<string, User>;
  private readonly agents: Map<string, AgentIdentity>;
  private readonly roles: Map<string, Role>;
  private readonly assignments: UserRootRoleAssignment[];
  private readonly delegations: AgentDelegation[];

  constructor(data: InMemoryRbacAuthorityData = {}) {
    this.users = new Map(
      (data.users ?? []).map((user) => [user.id, user]),
    );
    this.agents = new Map(
      (data.agents ?? []).map((agent) => [agent.id, agent]),
    );
    this.roles = new Map(
      (data.roles ?? []).map((role) => [role.id, role]),
    );
    this.assignments = [...(data.assignments ?? [])];
    this.delegations = [...(data.delegations ?? [])];
  }

  async getUser(userId: string): Promise<User | undefined> {
    return this.users.get(userId);
  }

  async getAgent(agentId: string): Promise<AgentIdentity | undefined> {
    return this.agents.get(agentId);
  }

  async getRole(roleId: string): Promise<Role | undefined> {
    return this.roles.get(roleId);
  }

  async listUserRootRoleAssignments(
    userId: string,
    rootEntityId: string,
  ): Promise<UserRootRoleAssignment[]> {
    return this.assignments.filter(
      (assignment) =>
        assignment.userId === userId &&
        assignment.rootEntityId === rootEntityId,
    );
  }

  async listAgentDelegations(
    agentId: string,
    rootEntityId: string,
  ): Promise<AgentDelegation[]> {
    return this.delegations.filter(
      (delegation) =>
        delegation.agentId === agentId &&
        delegation.rootEntityId === rootEntityId,
    );
  }

  setUserStatus(
    userId: string,
    status: User["status"],
  ): void {
    const user = this.users.get(userId);
    if (user !== undefined) {
      user.status = status;
    }
  }

  setAgentStatus(
    agentId: string,
    status: AgentIdentity["status"],
  ): void {
    const agent = this.agents.get(agentId);
    if (agent !== undefined) {
      agent.status = status;
    }
  }

  revokeDelegation(delegationId: string, revokedAt: string): void {
    const delegation = this.delegations.find(
      (candidate) => candidate.id === delegationId,
    );
    if (delegation !== undefined) {
      delegation.status = "revoked";
      delegation.revokedAt = revokedAt;
    }
  }
}
