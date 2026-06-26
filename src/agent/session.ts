import type {
  MemoryAction,
  PermissionRequest,
  PrincipalContext,
  RbacAuthority,
  TaskScope,
} from "../contracts/rbac.ts";
import type {
  MemoryObjectKind,
  MemoryRelationType,
} from "../contracts/memory.ts";
import type { MemoryOperation } from "../contracts/history.ts";

export interface AgentSessionRecord extends PrincipalContext {
  token: string;
  createdAt: string;
  expiresAt: string;
}

export interface CreateAgentSessionInput {
  userId: string;
  agentId: string;
  rootEntityId: string;
  taskScope: TaskScope;
  delegationId?: string;
  parentAgentId?: string;
  expiresAt: string;
}

export interface AgentSessionAuthority {
  create(input: CreateAgentSessionInput): Promise<AgentSessionRecord>;
  resolve(token: string): Promise<PrincipalContext>;
  revoke(sessionId: string): void;
}

function isActiveAt(
  record: { status: "active" | "revoked"; expiresAt?: string },
  now: Date,
): boolean {
  return (
    record.status === "active" &&
    (record.expiresAt === undefined ||
      new Date(record.expiresAt).getTime() > now.getTime())
  );
}

export class InMemoryAgentSessionAuthority
  implements AgentSessionAuthority
{
  private readonly sessions = new Map<string, AgentSessionRecord>();
  private readonly revoked = new Set<string>();
  private readonly rbac: RbacAuthority;
  private readonly now: () => Date;
  private readonly randomId: () => string;

  constructor(
    rbac: RbacAuthority,
    options: {
      now?: () => Date;
      randomId?: () => string;
    } = {},
  ) {
    this.rbac = rbac;
    this.now = options.now ?? (() => new Date());
    this.randomId =
      options.randomId ?? (() => globalThis.crypto.randomUUID());
  }

  async create(
    input: CreateAgentSessionInput,
  ): Promise<AgentSessionRecord> {
    if (input.taskScope.rootEntityId !== input.rootEntityId) {
      throw new Error("session TaskScope root does not match session root");
    }
    if (new Date(input.expiresAt).getTime() <= this.now().getTime()) {
      throw new Error("session expiration must be in the future");
    }
    await this.assertActiveIdentity(
      input.userId,
      input.agentId,
      input.rootEntityId,
      input.delegationId,
    );
    if (input.parentAgentId !== undefined) {
      const parent = await this.rbac.getAgent(input.parentAgentId);
      if (
        parent === undefined ||
        parent.status !== "active" ||
        parent.ownerUserId !== input.userId
      ) {
        throw new Error("session parent Agent is invalid");
      }
    }
    const sessionId = `session:${this.randomId()}`;
    const record: AgentSessionRecord = {
      sessionId,
      token: `agent-session:${this.randomId()}`,
      userId: input.userId,
      agentId: input.agentId,
      rootEntityId: input.rootEntityId,
      taskScope: structuredClone(input.taskScope),
      ...(input.delegationId === undefined
        ? {}
        : { delegationId: input.delegationId }),
      ...(input.parentAgentId === undefined
        ? {}
        : { parentAgentId: input.parentAgentId }),
      createdAt: this.now().toISOString(),
      expiresAt: input.expiresAt,
    };
    this.sessions.set(record.token, record);
    return structuredClone(record);
  }

  async resolve(token: string): Promise<PrincipalContext> {
    const record = this.sessions.get(token);
    if (
      record === undefined ||
      this.revoked.has(record.sessionId)
    ) {
      throw new Error("invalid agent session");
    }
    if (new Date(record.expiresAt).getTime() <= this.now().getTime()) {
      throw new Error("agent session expired");
    }
    await this.assertActiveIdentity(
      record.userId,
      record.agentId,
      record.rootEntityId,
      record.delegationId,
    );
    return {
      sessionId: record.sessionId,
      userId: record.userId,
      agentId: record.agentId,
      rootEntityId: record.rootEntityId,
      taskScope: structuredClone(record.taskScope),
      ...(record.delegationId === undefined
        ? {}
        : { delegationId: record.delegationId }),
      ...(record.parentAgentId === undefined
        ? {}
        : { parentAgentId: record.parentAgentId }),
    };
  }

  revoke(sessionId: string): void {
    this.revoked.add(sessionId);
  }

  private async assertActiveIdentity(
    userId: string,
    agentId: string,
    rootEntityId: string,
    delegationId: string | undefined,
  ): Promise<void> {
    const user = await this.rbac.getUser(userId);
    if (user === undefined || user.status !== "active") {
      throw new Error("session user is inactive");
    }
    const agent = await this.rbac.getAgent(agentId);
    if (
      agent === undefined ||
      agent.status !== "active" ||
      agent.ownerUserId !== userId
    ) {
      throw new Error("session agent does not belong to the user");
    }
    if (delegationId !== undefined) {
      const delegation = (
        await this.rbac.listAgentDelegations(agentId, rootEntityId)
      ).find((candidate) => candidate.id === delegationId);
      if (
        delegation === undefined ||
        delegation.ownerUserId !== userId ||
        !isActiveAt(delegation, this.now())
      ) {
        throw new Error("session delegation is inactive");
      }
    }
  }
}

export interface SessionPermissionInput {
  action: MemoryAction;
  resourceKind: MemoryObjectKind;
  branchRef?: string;
  entityId?: string;
  resourceId?: string;
  tags?: string[];
  relationType?: MemoryRelationType;
  relationDepth?: number;
}

const forbiddenIdentityFields = [
  "subject",
  "userId",
  "ownerUserId",
  "agentId",
  "rootEntityId",
  "taskScope",
] as const;

export function permissionRequestFromPrincipal(
  principal: PrincipalContext,
  input: SessionPermissionInput,
): PermissionRequest {
  for (const field of forbiddenIdentityFields) {
    if (field in input) {
      throw new Error(`tool input cannot override ${field}`);
    }
  }
  return {
    subject: {
      kind: "agent",
      agentId: principal.agentId,
      ownerUserId: principal.userId,
    },
    rootEntityId: principal.rootEntityId,
    action: input.action,
    resourceKind: input.resourceKind,
    taskScope: structuredClone(principal.taskScope),
    ...(input.branchRef === undefined
      ? {}
      : { branchRef: input.branchRef }),
    ...(input.entityId === undefined ? {} : { entityId: input.entityId }),
    ...(input.resourceId === undefined
      ? {}
      : { resourceId: input.resourceId }),
    ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
    ...(input.relationType === undefined
      ? {}
      : { relationType: input.relationType }),
    ...(input.relationDepth === undefined
      ? {}
      : { relationDepth: input.relationDepth }),
  };
}

export function provenanceFromPrincipal(
  principal: PrincipalContext,
): NonNullable<MemoryOperation["provenance"]> {
  return {
    sessionId: principal.sessionId,
    ownerUserId: principal.userId,
    ...(principal.delegationId === undefined
      ? {}
      : { delegationId: principal.delegationId }),
    ...(principal.parentAgentId === undefined
      ? {}
      : { parentAgentId: principal.parentAgentId }),
  };
}
