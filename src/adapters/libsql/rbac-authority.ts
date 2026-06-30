import { createHash, randomBytes } from "node:crypto";
import type { Client, InValue } from "@libsql/client";
import type {
  AgentDelegation,
  AgentIdentity,
  PermissionSubject,
  PrincipalContext,
  RbacAuthority,
  Role,
  TaskScope,
  User,
  UserRootRoleAssignment,
} from "../../contracts/rbac.ts";
import type { LibsqlClient } from "./client.ts";

const RBAC_SCHEMA = `
create table if not exists rbac_users (user_id text primary key, payload_json text not null);
create table if not exists rbac_agents (agent_id text primary key, owner_user_id text not null, payload_json text not null);
create table if not exists rbac_roles (role_id text primary key, payload_json text not null);
create table if not exists rbac_assignments (assignment_id text primary key, user_id text not null, root_entity_id text not null, payload_json text not null);
create index if not exists rbac_assignments_subject_root on rbac_assignments(user_id, root_entity_id);
create table if not exists rbac_delegations (delegation_id text primary key, agent_id text not null, owner_user_id text not null, root_entity_id text not null, payload_json text not null);
create index if not exists rbac_delegations_agent_root on rbac_delegations(agent_id, root_entity_id);
create table if not exists rbac_sessions (session_id text primary key, token_hash text not null unique, user_id text not null, agent_id text, root_entity_id text not null, task_scope_json text not null, delegation_id text, parent_agent_id text, expires_at text not null, revoked_at text, created_at text not null);
create table if not exists rbac_audit_log (audit_id text primary key, root_entity_id text not null, actor_user_id text not null, action text not null, payload_json text not null, created_at text not null);
create index if not exists rbac_audit_log_root_created on rbac_audit_log(root_entity_id, created_at);
`;

export interface AuthenticatedSession {
  sessionId: string;
  userId: string;
  agentId?: string;
  rootEntityId: string;
  taskScope: TaskScope;
  delegationId?: string;
  parentAgentId?: string;
  subject: PermissionSubject;
  /** Available only when this is an Agent session. */
  principal?: PrincipalContext;
}

export interface CreateSessionInput {
  id: string;
  userId: string;
  rootEntityId: string;
  taskScope: TaskScope;
  expiresAt: string;
  agentId?: string;
  delegationId?: string;
  parentAgentId?: string;
  createdAt: string;
}

export interface CreatedSession {
  id: string;
  /** Return this once; only its SHA-256 digest is persisted. */
  token: string;
}

export interface RbacAuditRecord {
  id: string;
  rootEntityId: string;
  actorUserId: string;
  action: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

function value(row: Record<string, unknown>, key: string): string | null {
  const result = row[key];
  return typeof result === "string" ? result : result === null ? null : null;
}

function parse<T>(row: Record<string, unknown>, key = "payload_json"): T {
  const serialized = value(row, key);
  if (serialized === null) {
    throw new Error(`libSQL row is missing ${key}`);
  }
  return JSON.parse(serialized) as T;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isActive(record: { status: "active" | "revoked"; expiresAt?: string }): boolean {
  return (
    record.status === "active" &&
    (record.expiresAt === undefined || new Date(record.expiresAt) > new Date())
  );
}

/** libSQL-backed authority for identities and RootEntity-scoped grants. */
export class LibsqlRbacAuthority implements RbacAuthority {
  private readonly client: LibsqlClient;

  constructor(client: LibsqlClient) { this.client = client; }

  static async create(client: LibsqlClient): Promise<LibsqlRbacAuthority> {
    const authority = new LibsqlRbacAuthority(client);
    await authority.initialize();
    return authority;
  }

  async initialize(): Promise<void> {
    await this.client.executeMultiple(RBAC_SCHEMA);
  }

  async getUser(userId: string): Promise<User | undefined> {
    return this.getOne<User>("select payload_json from rbac_users where user_id = ?", [userId]);
  }

  async getAgent(agentId: string): Promise<AgentIdentity | undefined> {
    return this.getOne<AgentIdentity>("select payload_json from rbac_agents where agent_id = ?", [agentId]);
  }

  async getRole(roleId: string): Promise<Role | undefined> {
    return this.getOne<Role>("select payload_json from rbac_roles where role_id = ?", [roleId]);
  }

  async listUserRootRoleAssignments(userId: string, rootEntityId: string): Promise<UserRootRoleAssignment[]> {
    return this.getMany<UserRootRoleAssignment>(
      "select payload_json from rbac_assignments where user_id = ? and root_entity_id = ?",
      [userId, rootEntityId],
    );
  }

  async listAgentDelegations(agentId: string, rootEntityId: string): Promise<AgentDelegation[]> {
    return this.getMany<AgentDelegation>(
      "select payload_json from rbac_delegations where agent_id = ? and root_entity_id = ?",
      [agentId, rootEntityId],
    );
  }

  async listRootAssignments(rootEntityId: string): Promise<UserRootRoleAssignment[]> {
    return this.getMany<UserRootRoleAssignment>(
      "select payload_json from rbac_assignments where root_entity_id = ? order by user_id, assignment_id",
      [rootEntityId],
    );
  }

  async listRootDelegations(rootEntityId: string): Promise<AgentDelegation[]> {
    return this.getMany<AgentDelegation>(
      "select payload_json from rbac_delegations where root_entity_id = ? order by agent_id, delegation_id",
      [rootEntityId],
    );
  }

  async saveUser(user: User): Promise<void> {
    await this.upsert("rbac_users", "user_id", user.id, user);
  }

  async saveAgent(agent: AgentIdentity): Promise<void> {
    await this.client.execute({
      sql: "insert into rbac_agents(agent_id, owner_user_id, payload_json) values (?, ?, ?) on conflict(agent_id) do update set owner_user_id = excluded.owner_user_id, payload_json = excluded.payload_json",
      args: [agent.id, agent.ownerUserId, JSON.stringify(agent)],
    });
  }

  async saveRole(role: Role): Promise<void> {
    await this.upsert("rbac_roles", "role_id", role.id, role);
  }

  async saveAssignment(assignment: UserRootRoleAssignment): Promise<void> {
    await this.client.execute({
      sql: "insert into rbac_assignments(assignment_id, user_id, root_entity_id, payload_json) values (?, ?, ?, ?) on conflict(assignment_id) do update set user_id = excluded.user_id, root_entity_id = excluded.root_entity_id, payload_json = excluded.payload_json",
      args: [assignment.id, assignment.userId, assignment.rootEntityId, JSON.stringify(assignment)],
    });
  }

  async saveDelegation(delegation: AgentDelegation): Promise<void> {
    await this.client.execute({
      sql: "insert into rbac_delegations(delegation_id, agent_id, owner_user_id, root_entity_id, payload_json) values (?, ?, ?, ?, ?) on conflict(delegation_id) do update set agent_id = excluded.agent_id, owner_user_id = excluded.owner_user_id, root_entity_id = excluded.root_entity_id, payload_json = excluded.payload_json",
      args: [delegation.id, delegation.agentId, delegation.ownerUserId, delegation.rootEntityId, JSON.stringify(delegation)],
    });
  }

  async revokeAssignment(id: string, revokedAt: string): Promise<void> {
    await this.revoke<UserRootRoleAssignment>("rbac_assignments", "assignment_id", id, revokedAt);
  }

  async revokeDelegation(id: string, revokedAt: string): Promise<void> {
    await this.revoke<AgentDelegation>("rbac_delegations", "delegation_id", id, revokedAt);
  }

  async createSession(input: CreateSessionInput): Promise<CreatedSession> {
    if (input.taskScope.rootEntityId !== input.rootEntityId) {
      throw new Error("session task scope must match rootEntityId");
    }
    const user = await this.getUser(input.userId);
    if (user?.status !== "active") {
      throw new Error("session user is inactive");
    }
    if (input.agentId !== undefined) {
      const agent = await this.getAgent(input.agentId);
      if (agent?.status !== "active" || agent.ownerUserId !== input.userId) {
        throw new Error("session agent is not owned by the user");
      }
      if (input.delegationId === undefined) {
        throw new Error("agent session requires delegationId");
      }
      const delegation = (await this.listAgentDelegations(input.agentId, input.rootEntityId)).find(
        (candidate) => candidate.id === input.delegationId,
      );
      if (delegation === undefined || !isActive(delegation)) {
        throw new Error("session delegation is inactive");
      }
    }
    const token = randomBytes(32).toString("base64url");
    await this.client.execute({
      sql: "insert into rbac_sessions(session_id, token_hash, user_id, agent_id, root_entity_id, task_scope_json, delegation_id, parent_agent_id, expires_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        input.id,
        tokenHash(token),
        input.userId,
        input.agentId ?? null,
        input.rootEntityId,
        JSON.stringify(input.taskScope),
        input.delegationId ?? null,
        input.parentAgentId ?? null,
        input.expiresAt,
        input.createdAt,
      ],
    });
    return { id: input.id, token };
  }

  async revokeSession(sessionId: string, revokedAt: string): Promise<void> {
    await this.client.execute({ sql: "update rbac_sessions set revoked_at = ? where session_id = ?", args: [revokedAt, sessionId] });
  }

  async authenticate(token: string): Promise<AuthenticatedSession | undefined> {
    const result = await this.client.execute({
      sql: "select session_id, user_id, agent_id, root_entity_id, task_scope_json, delegation_id, parent_agent_id, expires_at, revoked_at from rbac_sessions where token_hash = ?",
      args: [tokenHash(token)],
    });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined || value(row, "revoked_at") !== null) return undefined;
    const expiresAt = value(row, "expires_at");
    const userId = value(row, "user_id");
    const rootEntityId = value(row, "root_entity_id");
    const sessionId = value(row, "session_id");
    if (expiresAt === null || userId === null || rootEntityId === null || sessionId === null || new Date(expiresAt) <= new Date()) return undefined;
    const user = await this.getUser(userId);
    if (user?.status !== "active") return undefined;
    const agentId = value(row, "agent_id") ?? undefined;
    const delegationId = value(row, "delegation_id") ?? undefined;
    const taskScope = parse<TaskScope>(row, "task_scope_json");
    if (taskScope.rootEntityId !== rootEntityId) return undefined;
    if (agentId === undefined) {
      return { sessionId, userId, rootEntityId, taskScope, subject: { kind: "user", userId } };
    }
    const agent = await this.getAgent(agentId);
    const delegation = (await this.listAgentDelegations(agentId, rootEntityId)).find((candidate) => candidate.id === delegationId);
    if (agent?.status !== "active" || agent.ownerUserId !== userId || delegation === undefined || !isActive(delegation)) return undefined;
    const parentAgentId = value(row, "parent_agent_id") ?? undefined;
    const principal: PrincipalContext = {
      sessionId,
      userId,
      agentId,
      rootEntityId,
      taskScope,
      ...(delegationId === undefined ? {} : { delegationId }),
      ...(parentAgentId === undefined ? {} : { parentAgentId }),
    };
    return { ...principal, subject: { kind: "agent", agentId, ownerUserId: userId }, principal };
  }

  async appendAudit(record: RbacAuditRecord): Promise<void> {
    await this.client.execute({
      sql: "insert into rbac_audit_log(audit_id, root_entity_id, actor_user_id, action, payload_json, created_at) values (?, ?, ?, ?, ?, ?)",
      args: [record.id, record.rootEntityId, record.actorUserId, record.action, JSON.stringify(record.payload), record.createdAt],
    });
  }

  async listAudit(rootEntityId: string): Promise<RbacAuditRecord[]> {
    const result = await this.client.execute({ sql: "select audit_id, root_entity_id, actor_user_id, action, payload_json, created_at from rbac_audit_log where root_entity_id = ? order by created_at", args: [rootEntityId] });
    return result.rows.map((candidate) => {
      const row = candidate as Record<string, unknown>;
      const id = value(row, "audit_id"); const actorUserId = value(row, "actor_user_id"); const action = value(row, "action"); const createdAt = value(row, "created_at");
      if (id === null || actorUserId === null || action === null || createdAt === null) throw new Error("invalid audit row");
      return { id, rootEntityId, actorUserId, action, payload: parse<Record<string, unknown>>(row), createdAt };
    });
  }

  private async getOne<T>(sql: string, args: InValue[]): Promise<T | undefined> {
    const result = await this.client.execute({ sql, args });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row === undefined ? undefined : parse<T>(row);
  }

  private async getMany<T>(sql: string, args: InValue[]): Promise<T[]> {
    const result = await this.client.execute({ sql, args });
    return result.rows.map((candidate) => parse<T>(candidate as Record<string, unknown>));
  }

  private async upsert(table: string, idColumn: string, id: string, payload: unknown): Promise<void> {
    await this.client.execute({ sql: `insert into ${table}(${idColumn}, payload_json) values (?, ?) on conflict(${idColumn}) do update set payload_json = excluded.payload_json`, args: [id, JSON.stringify(payload)] });
  }

  private async revoke<T extends { status: "active" | "revoked"; revokedAt?: string }>(table: string, idColumn: string, id: string, revokedAt: string): Promise<void> {
    const result = await this.client.execute({ sql: `select payload_json from ${table} where ${idColumn} = ?`, args: [id] });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error(`${idColumn} not found: ${id}`);
    const record = parse<T>(row);
    record.status = "revoked";
    record.revokedAt = revokedAt;
    await this.client.execute({ sql: `update ${table} set payload_json = ? where ${idColumn} = ?`, args: [JSON.stringify(record), id] });
  }
}

export type { Client };
