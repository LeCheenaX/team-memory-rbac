import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
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
create table if not exists rbac_delegations (delegation_id text primary key, agent_id text, owner_user_id text not null, root_entity_id text not null, payload_json text not null);
create index if not exists rbac_delegations_agent_root on rbac_delegations(agent_id, root_entity_id);
create table if not exists rbac_sessions (session_id text primary key, token_hash text not null unique, user_id text not null, agent_id text, root_entity_id text not null, task_scope_json text not null, delegation_id text, parent_agent_id text, expires_at text not null, revoked_at text, created_at text not null);
create table if not exists rbac_user_credentials (user_id text primary key, password_hash text not null, created_at text not null, updated_at text not null);
create table if not exists rbac_audit_log (audit_id text primary key, root_entity_id text not null, actor_user_id text not null, action text not null, payload_json text not null, created_at text not null);
create index if not exists rbac_audit_log_root_created on rbac_audit_log(root_entity_id, created_at);
create table if not exists rbac_permission_watermarks (subject_id text not null, root_entity_id text not null, watermark integer not null, updated_at text not null, primary key(subject_id, root_entity_id));
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

export interface PasswordCredentialInput {
  userId: string;
  password: string;
  now: string;
}

export interface CreateUserSessionWithPasswordInput {
  id: string;
  userId: string;
  password: string;
  rootEntityId: string;
  taskScope: TaskScope;
  expiresAt: string;
  createdAt: string;
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

function passwordHash(password: string): string {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, 64).toString("base64url");
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password: string, serialized: string): boolean {
  const [kind, salt, expected] = serialized.split(":");
  if (kind !== "scrypt" || salt === undefined || expected === undefined) return false;
  const actual = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "base64url");
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
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
      "select payload_json from rbac_delegations where (agent_id = ? or agent_id is null) and root_entity_id = ?",
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
    await this.advanceUserEverywhere(user.id);
  }

  async saveAgent(agent: AgentIdentity): Promise<void> {
    await this.client.execute({
      sql: "insert into rbac_agents(agent_id, owner_user_id, payload_json) values (?, ?, ?) on conflict(agent_id) do update set owner_user_id = excluded.owner_user_id, payload_json = excluded.payload_json",
      args: [agent.id, agent.ownerUserId, JSON.stringify(agent)],
    });
    await this.advanceAgentEverywhere(agent.id);
  }

  async saveRole(role: Role): Promise<void> {
    await this.upsert("rbac_roles", "role_id", role.id, role);
    await this.advanceRoleAssignments(role.id);
  }

  async saveAssignment(assignment: UserRootRoleAssignment): Promise<void> {
    await this.client.execute({
      sql: "insert into rbac_assignments(assignment_id, user_id, root_entity_id, payload_json) values (?, ?, ?, ?) on conflict(assignment_id) do update set user_id = excluded.user_id, root_entity_id = excluded.root_entity_id, payload_json = excluded.payload_json",
      args: [assignment.id, assignment.userId, assignment.rootEntityId, JSON.stringify(assignment)],
    });
    await this.advanceUserAtRoot(assignment.userId, assignment.rootEntityId);
  }

  async saveDelegation(delegation: AgentDelegation): Promise<void> {
    await this.client.execute({
      sql: "insert into rbac_delegations(delegation_id, agent_id, owner_user_id, root_entity_id, payload_json) values (?, ?, ?, ?, ?) on conflict(delegation_id) do update set agent_id = excluded.agent_id, owner_user_id = excluded.owner_user_id, root_entity_id = excluded.root_entity_id, payload_json = excluded.payload_json",
      args: [delegation.id, delegation.agentId ?? null, delegation.ownerUserId, delegation.rootEntityId, JSON.stringify(delegation)],
    });
    if (delegation.agentId === undefined) {
      await this.advanceUserAtRoot(delegation.ownerUserId, delegation.rootEntityId);
    } else {
      await this.advancePermissionWatermark(delegation.agentId, delegation.rootEntityId);
    }
  }

  async revokeAssignment(id: string, revokedAt: string): Promise<void> {
    const assignment = await this.revoke<UserRootRoleAssignment>("rbac_assignments", "assignment_id", id, revokedAt);
    await this.advanceUserAtRoot(assignment.userId, assignment.rootEntityId);
  }

  async revokeDelegation(id: string, revokedAt: string): Promise<void> {
    const delegation = await this.revoke<AgentDelegation>("rbac_delegations", "delegation_id", id, revokedAt);
    if (delegation.agentId === undefined) {
      await this.advanceUserAtRoot(delegation.ownerUserId, delegation.rootEntityId);
    } else {
      await this.advancePermissionWatermark(delegation.agentId, delegation.rootEntityId);
    }
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

  async setUserPassword(input: PasswordCredentialInput): Promise<void> {
    if (input.password.length === 0) throw new Error("password must not be empty");
    const user = await this.getUser(input.userId);
    if (user?.status !== "active") throw new Error("credential user is inactive");
    await this.client.execute({
      sql: "insert into rbac_user_credentials(user_id, password_hash, created_at, updated_at) values (?, ?, ?, ?) on conflict(user_id) do update set password_hash = excluded.password_hash, updated_at = excluded.updated_at",
      args: [input.userId, passwordHash(input.password), input.now, input.now],
    });
  }

  async createUserSessionWithPassword(input: CreateUserSessionWithPasswordInput): Promise<CreatedSession> {
    if (input.taskScope.rootEntityId !== input.rootEntityId) {
      throw new Error("session task scope must match rootEntityId");
    }
    const user = await this.getUser(input.userId);
    if (user?.status !== "active") throw new Error("session user is inactive");
    const credential = await this.client.execute({
      sql: "select password_hash from rbac_user_credentials where user_id = ?",
      args: [input.userId],
    });
    const credentialRow = credential.rows[0] as Record<string, unknown> | undefined;
    const serialized = credentialRow === undefined ? null : value(credentialRow, "password_hash");
    if (serialized === null || !verifyPassword(input.password, serialized)) {
      throw new Error("invalid user credentials");
    }
    const existing = await this.client.execute({
      sql: "select user_id, agent_id from rbac_sessions where session_id = ?",
      args: [input.id],
    });
    const existingRow = existing.rows[0] as Record<string, unknown> | undefined;
    if (existingRow !== undefined) {
      const existingUserId = value(existingRow, "user_id");
      const existingAgentId = value(existingRow, "agent_id");
      if (existingUserId !== input.userId || existingAgentId !== null) {
        throw new Error("password login cannot replace a different principal session");
      }
    }
    const token = randomBytes(32).toString("base64url");
    await this.client.execute({
      sql: "insert into rbac_sessions(session_id, token_hash, user_id, agent_id, root_entity_id, task_scope_json, delegation_id, parent_agent_id, expires_at, revoked_at, created_at) values (?, ?, ?, null, ?, ?, null, null, ?, null, ?) on conflict(session_id) do update set token_hash = excluded.token_hash, user_id = excluded.user_id, agent_id = null, root_entity_id = excluded.root_entity_id, task_scope_json = excluded.task_scope_json, delegation_id = null, parent_agent_id = null, expires_at = excluded.expires_at, revoked_at = null, created_at = excluded.created_at",
      args: [
        input.id,
        tokenHash(token),
        input.userId,
        input.rootEntityId,
        JSON.stringify(input.taskScope),
        input.expiresAt,
        input.createdAt,
      ],
    });
    await this.advancePermissionWatermark(input.userId, input.rootEntityId, input.createdAt);
    return { id: input.id, token };
  }

  async revokeSession(sessionId: string, revokedAt: string): Promise<void> {
    const session = await this.sessionWatermarkSubject(sessionId);
    await this.client.execute({ sql: "update rbac_sessions set revoked_at = ? where session_id = ?", args: [revokedAt, sessionId] });
    if (session !== undefined) await this.advancePermissionWatermark(session.subjectId, session.rootEntityId);
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

  async get(subjectId: string, rootEntityId: string): Promise<string> {
    return this.getPermissionWatermark(subjectId, rootEntityId);
  }

  async getPermissionWatermark(subjectId: string, rootEntityId: string): Promise<string> {
    const result = await this.client.execute({
      sql: "select watermark from rbac_permission_watermarks where subject_id = ? and root_entity_id = ?",
      args: [subjectId, rootEntityId],
    });
    const watermark = result.rows[0]?.watermark;
    if (typeof watermark === "number" || typeof watermark === "bigint") return String(watermark);
    return "0";
  }

  async advancePermissionWatermark(subjectId: string, rootEntityId: string, updatedAt = new Date().toISOString()): Promise<string> {
    await this.client.execute({
      sql: "insert into rbac_permission_watermarks(subject_id, root_entity_id, watermark, updated_at) values (?, ?, 1, ?) on conflict(subject_id, root_entity_id) do update set watermark = watermark + 1, updated_at = excluded.updated_at",
      args: [subjectId, rootEntityId, updatedAt],
    });
    return this.getPermissionWatermark(subjectId, rootEntityId);
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

  private async revoke<T extends { status: "active" | "revoked"; revokedAt?: string }>(table: string, idColumn: string, id: string, revokedAt: string): Promise<T> {
    const result = await this.client.execute({ sql: `select payload_json from ${table} where ${idColumn} = ?`, args: [id] });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error(`${idColumn} not found: ${id}`);
    const record = parse<T>(row);
    record.status = "revoked";
    record.revokedAt = revokedAt;
    await this.client.execute({ sql: `update ${table} set payload_json = ? where ${idColumn} = ?`, args: [JSON.stringify(record), id] });
    return record;
  }

  private async advanceUserAtRoot(userId: string, rootEntityId: string): Promise<void> {
    await this.advancePermissionWatermark(userId, rootEntityId);
    const agentIds = await this.agentIdsOwnedByUserAtRoot(userId, rootEntityId);
    for (const agentId of agentIds) await this.advancePermissionWatermark(agentId, rootEntityId);
  }

  private async advanceUserEverywhere(userId: string): Promise<void> {
    const roots = await this.rootsForUser(userId);
    for (const rootEntityId of roots) await this.advanceUserAtRoot(userId, rootEntityId);
  }

  private async advanceAgentEverywhere(agentId: string): Promise<void> {
    const roots = await this.rootsForAgent(agentId);
    for (const rootEntityId of roots) await this.advancePermissionWatermark(agentId, rootEntityId);
  }

  private async advanceRoleAssignments(roleId: string): Promise<void> {
    const assignments = await this.getMany<UserRootRoleAssignment>("select payload_json from rbac_assignments", []);
    const affected = new Set(
      assignments
        .filter((assignment) => assignment.roleId === roleId)
        .map((assignment) => `${assignment.userId}\0${assignment.rootEntityId}`),
    );
    for (const key of affected) {
      const [userId, rootEntityId] = key.split("\0");
      if (userId !== undefined && rootEntityId !== undefined) await this.advanceUserAtRoot(userId, rootEntityId);
    }
  }

  private async rootsForUser(userId: string): Promise<string[]> {
    const [assignmentRows, delegationRows] = await Promise.all([
      this.client.execute({ sql: "select distinct root_entity_id from rbac_assignments where user_id = ?", args: [userId] }),
      this.client.execute({ sql: "select distinct root_entity_id from rbac_delegations where owner_user_id = ?", args: [userId] }),
    ]);
    return [...new Set([...assignmentRows.rows, ...delegationRows.rows].flatMap((row) => {
      const value = (row as Record<string, unknown>).root_entity_id;
      return typeof value === "string" ? [value] : [];
    }))];
  }

  private async rootsForAgent(agentId: string): Promise<string[]> {
    const result = await this.client.execute({ sql: "select distinct root_entity_id from rbac_delegations where agent_id = ? or agent_id is null", args: [agentId] });
    return result.rows.flatMap((row) => {
      const value = (row as Record<string, unknown>).root_entity_id;
      return typeof value === "string" ? [value] : [];
    });
  }

  private async agentIdsOwnedByUserAtRoot(userId: string, rootEntityId: string): Promise<string[]> {
    const result = await this.client.execute({
      sql: "select distinct agent_id from rbac_delegations where owner_user_id = ? and root_entity_id = ? and agent_id is not null",
      args: [userId, rootEntityId],
    });
    return result.rows.flatMap((row) => {
      const value = (row as Record<string, unknown>).agent_id;
      return typeof value === "string" ? [value] : [];
    });
  }

  private async sessionWatermarkSubject(sessionId: string): Promise<{ subjectId: string; rootEntityId: string } | undefined> {
    const result = await this.client.execute({
      sql: "select user_id, agent_id, root_entity_id from rbac_sessions where session_id = ?",
      args: [sessionId],
    });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    const userId = value(row, "user_id");
    const agentId = value(row, "agent_id");
    const rootEntityId = value(row, "root_entity_id");
    if (userId === null || rootEntityId === null) return undefined;
    return { subjectId: agentId ?? userId, rootEntityId };
  }
}

export type { Client };
