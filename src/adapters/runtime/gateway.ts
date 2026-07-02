import { ResourceNotFoundError } from "../../resources/service.ts";
import {
  CloudAuthorizedViewAdapter,
  ConflictResolutionAdapter,
  InMemoryAuthorizedQuerySource,
  MemoryRetrievalAdapter,
  PermissionRouter,
  type AuthorizedSyncBatch,
  type AuthorizedSyncRequest,
  type CloudMemoryWriteCommand,
  type CloudMemoryWriteResult,
  type ConflictResolutionCommand,
  type ConflictResolutionResult,
  type MemoryAction,
  type MemoryObjectKind,
  type PermissionWatermarkProvider,
  type MemoryRetrievalRequest,
  type MemoryRetrievalResult,
  type PermissionDecision,
  type PermissionRouteResult,
  type ResourceSourceType,
} from "../../index.ts";
import type { AgentDelegation, UserRootRoleAssignment } from "../../contracts/rbac.ts";
import type { AgentType, Permission } from "../../contracts/rbac.ts";
import type { AuthenticatedSession } from "../libsql/rbac-authority.ts";
import type { CreatedSession } from "../libsql/rbac-authority.ts";
import type { TeamMemoryRuntime } from "./development-stack.ts";

export type GatewayErrorCode =
  | "auth_failed"
  | "permission_denied"
  | "conflict"
  | "validation_failed"
  | "dependency_unavailable"
  | "not_found";

export class TeamMemoryGatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly decision?: PermissionDecision & { allowed: false };

  constructor(
    code: GatewayErrorCode,
    message: string,
    decision?: PermissionDecision & { allowed: false },
  ) {
    super(`${code}: ${message}`);
    this.code = code;
    if (decision !== undefined) this.decision = decision;
  }
}

export interface TeamMemoryGatewayOptions {
  retrieval?: "runtime" | "active-view";
  permissionWatermarks?: PermissionWatermarkProvider;
}

const forbiddenPayloadFields = new Set([
  "subject",
  "userId",
  "ownerUserId",
  "agentId",
  "rootEntityId",
  "taskScope",
]);

function assertNoIdentityOverride(payload: Record<string, unknown>): void {
  for (const field of forbiddenPayloadFields) {
    if (field in payload) {
      throw new TeamMemoryGatewayError(
        "validation_failed",
        `request payload cannot provide ${field}`,
      );
    }
  }
}

function stringValue(
  payload: Record<string, unknown>,
  key: string,
): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TeamMemoryGatewayError(
      "validation_failed",
      `${key} is required`,
    );
  }
  return value;
}

function objectValue(
  payload: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = payload[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TeamMemoryGatewayError(
      "validation_failed",
      `${key} is required`,
    );
  }
  return value as Record<string, unknown>;
}

function optionalString(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new TeamMemoryGatewayError(
      "validation_failed",
      `${key} must be a non-empty string`,
    );
  }
  return value;
}

function denied<TResult>(
  result: PermissionRouteResult<TResult>,
): PermissionDecision & { allowed: false } | undefined {
  return "value" in result ? undefined : result.decision;
}

function unwrap<TResult>(result: PermissionRouteResult<TResult>): TResult {
  if ("value" in result) return result.value;
  throw new TeamMemoryGatewayError(
    "permission_denied",
    result.decision.reason,
    result.decision,
  );
}

function branchRef(payload: Record<string, unknown>): string {
  return optionalString(payload, "branchRef") ?? "main";
}

function numberValue(
  payload: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) {
    throw new TeamMemoryGatewayError(
      "validation_failed",
      `${key} must be an integer`,
    );
  }
  return value as number;
}

function gatewaySubject(session: AuthenticatedSession) {
  return session.subject;
}

function defaultAgentPermissions(ownerPermissions: readonly Permission[]): Permission[] {
  const desired = new Set([
    "read:memory_entity",
    "search:memory_entity",
    "write_entity:memory_entity",
    "write_entity_branch:memory_entity_branch",
    "import_resource:resource",
    "read:resource",
    "search:resource",
    "write_resource_chunk:resource_chunk",
    "index_resource:resource",
    "index_resource:resource_chunk",
  ]);
  return ownerPermissions.filter((permission) =>
    desired.has(`${permission.action}:${permission.resourceKind}`),
  );
}

const agentToolCatalog = [
  { name: "memory.importResource", description: "Import a resource", action: "import_resource", resourceKind: "resource" },
  { name: "memory.readResource", description: "Read a resource", action: "read", resourceKind: "resource" },
  { name: "memory.write", description: "Write memory", action: "write_entity", resourceKind: "memory_entity" },
  { name: "memory.search", description: "Search memory", action: "search", resourceKind: "memory_entity" },
  { name: "memory.history", description: "List memory history", action: "read", resourceKind: "memory_entity" },
  { name: "memory.conflicts", description: "List memory conflicts", action: "read", resourceKind: "memory_entity" },
  { name: "memory.resolveConflict", description: "Resolve memory conflicts", action: "merge", resourceKind: "memory_entity" },
  { name: "memory.syncPull", description: "Pull authorized sync events", action: "read", resourceKind: "memory_entity" },
] as const;

export class TeamMemoryGateway {
  private readonly runtime: TeamMemoryRuntime;
  private readonly writeRouter: PermissionRouter<
    CloudMemoryWriteResult,
    CloudMemoryWriteCommand
  >;
  private readonly retrievalRouter: PermissionRouter<
    MemoryRetrievalResult,
    MemoryRetrievalRequest
  >;
  private readonly resolutionRouter: PermissionRouter<
    ConflictResolutionResult,
    ConflictResolutionCommand
  >;
  private readonly syncRouter: PermissionRouter<
    AuthorizedSyncBatch,
    AuthorizedSyncRequest
  >;

  constructor(
    runtime: TeamMemoryRuntime,
    options: TeamMemoryGatewayOptions = {},
  ) {
    this.runtime = runtime;
    this.writeRouter = new PermissionRouter(runtime.policy, runtime.history);
    this.retrievalRouter =
      options.retrieval === "active-view"
        ? new PermissionRouter(
            runtime.policy,
            new MemoryRetrievalAdapter(
              new InMemoryAuthorizedQuerySource(
                (rootEntityId, branch) =>
                  runtime.history.readActiveView(rootEntityId, branch),
                "cloud_active",
              ),
            ),
          )
        : runtime.retrieval;
    this.resolutionRouter = new PermissionRouter(
      runtime.policy,
      new ConflictResolutionAdapter(runtime.history),
    );
    this.syncRouter = new PermissionRouter(
      runtime.policy,
      new CloudAuthorizedViewAdapter(
        runtime.history,
        options.permissionWatermarks ?? runtime.rbac,
      ),
    );
  }

  async authenticate(token: string | undefined): Promise<AuthenticatedSession> {
    if (token === undefined || token.length === 0) {
      throw new TeamMemoryGatewayError("auth_failed", "missing bearer token");
    }
    const session = await this.runtime.rbac.authenticate(token);
    if (session === undefined) {
      throw new TeamMemoryGatewayError("auth_failed", "invalid session");
    }
    return session;
  }

  async identity(token: string | undefined): Promise<{
    sessionId: string;
    userId: string;
    agentId?: string;
    rootEntityId: string;
    delegationId?: string;
  }> {
    const session = await this.authenticate(token);
    return {
      sessionId: session.sessionId,
      userId: session.userId,
      ...(session.agentId === undefined ? {} : { agentId: session.agentId }),
      rootEntityId: session.rootEntityId,
      ...(session.delegationId === undefined
        ? {}
        : { delegationId: session.delegationId }),
    };
  }

  async listAgentTools(token: string | undefined): Promise<Array<{
    name: string;
    description: string;
    inputSchema: { type: "object"; additionalProperties: true };
  }>> {
    const visible = [];
    for (const tool of agentToolCatalog) {
      const decision = await this.authorizeAgentTool(token, tool.name);
      if (decision.allowed) {
        visible.push({
          name: tool.name,
          description: tool.description,
          inputSchema: { type: "object" as const, additionalProperties: true as const },
        });
      }
    }
    return visible;
  }

  async authorizeAgentTool(
    token: string | undefined,
    toolName: string,
  ): Promise<PermissionDecision> {
    const session = await this.authenticate(token);
    const tool = agentToolCatalog.find((candidate) => candidate.name === toolName);
    if (tool === undefined) {
      throw new TeamMemoryGatewayError("validation_failed", `unknown tool: ${toolName}`);
    }
    if (session.subject.kind !== "agent") {
      return {
        allowed: false,
        reason: "agent_session_required",
        subjectId: session.userId,
        subjectKind: session.subject.kind,
        rootEntityId: session.rootEntityId,
        action: tool.action,
        resourceKind: tool.resourceKind,
        matchedRoles: [],
        missingActions: [tool.action],
        constraints: {},
      };
    }
    return this.runtime.policy.decide({
      subject: session.subject,
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      action: tool.action,
      resourceKind: tool.resourceKind,
    });
  }

  async listRoots(token: string | undefined): Promise<{ roots: string[] }> {
    const session = await this.authenticate(token);
    const decision = await this.runtime.policy.decide({
      subject: session.subject,
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      action: "read",
      resourceKind: "memory_entity",
    });
    if (!decision.allowed) {
      throw new TeamMemoryGatewayError(
        "permission_denied",
        decision.reason,
        decision as PermissionDecision & { allowed: false },
      );
    }
    return { roots: [session.rootEntityId] };
  }

  async listMembers(token: string | undefined): Promise<{
    assignments: UserRootRoleAssignment[];
  }> {
    const session = await this.requireHumanAdmin(token, "assign_user_role");
    return {
      assignments: await this.runtime.rbac.listRootAssignments(
        session.rootEntityId,
      ),
    };
  }

  async assignRole(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<UserRootRoleAssignment> {
    const session = await this.authenticate(token);
    return this.runtime.admin.assignRole(session, {
      id: stringValue(payload, "assignmentId"),
      userId: stringValue(payload, "userId"),
      rootEntityId: session.rootEntityId,
      roleId: stringValue(payload, "roleId"),
    });
  }

  async revokeRole(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<{ status: "revoked" }> {
    const session = await this.authenticate(token);
    await this.runtime.admin.revokeRole(session, {
      assignmentId: stringValue(payload, "assignmentId"),
      userId: stringValue(payload, "userId"),
    });
    return { status: "revoked" };
  }

  async listDelegations(token: string | undefined): Promise<{
    delegations: AgentDelegation[];
  }> {
    const session = await this.requireHumanAdmin(token, "assign_user_role");
    return {
      delegations: await this.runtime.rbac.listRootDelegations(
        session.rootEntityId,
      ),
    };
  }

  async createDelegation(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<AgentDelegation> {
    const session = await this.authenticate(token);
    return this.runtime.admin.createDelegation(session, {
      id: stringValue(payload, "delegationId"),
      agentId: stringValue(payload, "agentId"),
      rootEntityId: session.rootEntityId,
      permissions: (payload.permissions as AgentDelegation["permissions"] | undefined) ?? [],
      ...(optionalString(payload, "expiresAt") === undefined
        ? {}
        : { expiresAt: optionalString(payload, "expiresAt") as string }),
    });
  }

  async onboardAgent(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<{
    agentId: string;
    delegationId: string;
    session: CreatedSession;
  }> {
    const session = await this.requireHumanAdmin(token, "assign_user_role");
    const now = new Date().toISOString();
    const agentId = stringValue(payload, "agentId");
    const delegationId = stringValue(payload, "delegationId");
    const sessionId = stringValue(payload, "sessionId");
    const expiresAt = stringValue(payload, "sessionExpiresAt");
    const agentType = (optionalString(payload, "agentType") ?? "curator_agent") as AgentType;
    await this.runtime.rbac.saveAgent({
      id: agentId,
      ownerUserId: session.userId,
      agentType,
      displayName: optionalString(payload, "displayName") ?? agentId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const ownerPermissions = await this.effectiveUserPermissions(
      session.userId,
      session.rootEntityId,
    );
    await this.runtime.admin.createDelegation(session, {
      id: delegationId,
      agentId,
      rootEntityId: session.rootEntityId,
      permissions: (payload.permissions as Permission[] | undefined) ??
        defaultAgentPermissions(ownerPermissions),
      ...(optionalString(payload, "delegationExpiresAt") === undefined
        ? {}
        : { expiresAt: optionalString(payload, "delegationExpiresAt") as string }),
    });
    return {
      agentId,
      delegationId,
      session: await this.runtime.rbac.createSession({
        id: sessionId,
        userId: session.userId,
        agentId,
        delegationId,
        rootEntityId: session.rootEntityId,
        taskScope: { rootEntityId: session.rootEntityId },
        expiresAt,
        createdAt: now,
      }),
    };
  }

  private async effectiveUserPermissions(
    userId: string,
    rootEntityId: string,
  ): Promise<Permission[]> {
    const assignments = await this.runtime.rbac.listUserRootRoleAssignments(
      userId,
      rootEntityId,
    );
    const roles = await Promise.all(
      assignments
        .filter((assignment) => assignment.status === "active")
        .map((assignment) => this.runtime.rbac.getRole(assignment.roleId)),
    );
    return roles.flatMap((role) => role?.permissions ?? []);
  }

  async revokeDelegation(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<{ status: "revoked" }> {
    const session = await this.authenticate(token);
    await this.runtime.admin.revokeDelegation(session, {
      delegationId: stringValue(payload, "delegationId"),
      agentId: stringValue(payload, "agentId"),
    });
    return { status: "revoked" };
  }

  async syncStatus(token: string | undefined): Promise<{
    rootEntityId: string;
    commitWatermark: number;
    headCommitId?: string;
  }> {
    const session = await this.authenticate(token);
    const branch = "main";
    const decision = await this.runtime.policy.decide({
      subject: session.subject,
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      branchRef: branch,
      action: "read",
      resourceKind: "memory_entity",
    });
    if (!decision.allowed) {
      throw new TeamMemoryGatewayError(
        "permission_denied",
        decision.reason,
        decision as PermissionDecision & { allowed: false },
      );
    }
    const headCommitId = this.runtime.history.headCommitId(
      session.rootEntityId,
      branch,
    );
    return {
      rootEntityId: session.rootEntityId,
      commitWatermark: this.runtime.history.commitWatermark(),
      ...(headCommitId === undefined ? {} : { headCommitId }),
    };
  }

  async health(): Promise<{ live: true; ready: boolean; checks: Record<string, string> }> {
    try {
      await this.runtime.ready();
      return { live: true, ready: true, checks: { runtime: "ready" } };
    } catch (error) {
      return {
        live: true,
        ready: false,
        checks: {
          runtime: error instanceof Error ? error.message : "unknown error",
        },
      };
    }
  }

  async createRoot(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<{ status: "created" }> {
    assertNoIdentityOverride(payload);
    const session = await this.authenticate(token);
    await this.runtime.createRootEntity(session, {
      rootEntityId: stringValue(payload, "newRootEntityId"),
      clientMutationId: stringValue(payload, "clientMutationId"),
    });
    return { status: "created" };
  }

  private async requireHumanAdmin(
    token: string | undefined,
    action: "assign_user_role" | "revoke_user_role",
  ): Promise<AuthenticatedSession> {
    const session = await this.authenticate(token);
    if (session.subject.kind !== "user") {
      throw new TeamMemoryGatewayError(
        "permission_denied",
        "agents cannot perform administrator actions",
      );
    }
    const decision = await this.runtime.policy.decide({
      subject: session.subject,
      rootEntityId: session.rootEntityId,
      action,
      resourceKind: "memory_entity",
    });
    if (!decision.allowed) {
      throw new TeamMemoryGatewayError(
        "permission_denied",
        decision.reason,
        decision as PermissionDecision & { allowed: false },
      );
    }
    return session;
  }

  async importResource(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    assertNoIdentityOverride(payload);
    const session = await this.authenticate(token);
    const content =
      typeof payload.content === "string"
        ? payload.content
        : Buffer.from(stringValue(payload, "contentBase64"), "base64");
    return this.runtime.resources.import(session, {
      clientMutationId: stringValue(payload, "clientMutationId"),
      ...(typeof payload.resourceId === "string"
        ? { resourceId: payload.resourceId }
        : {}),
      title: stringValue(payload, "title"),
      sourceType: stringValue(payload, "sourceType") as ResourceSourceType,
      content,
      ...(typeof payload.uri === "string" ? { uri: payload.uri } : {}),
      ...(typeof payload.metadata === "object" && payload.metadata !== null
        ? { metadata: payload.metadata as Record<string, unknown> }
        : {}),
    });
  }

  async reviseResource(
    token: string | undefined,
    resourceId: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    assertNoIdentityOverride(payload);
    const session = await this.authenticate(token);
    const content =
      typeof payload.content === "string"
        ? payload.content
        : Buffer.from(stringValue(payload, "contentBase64"), "base64");
    return this.runtime.resources.revise(session, {
      clientMutationId: stringValue(payload, "clientMutationId"),
      resourceId,
      content,
    });
  }

  async readResource(
    token: string | undefined,
    resourceId: string,
    revisionId?: string,
  ): Promise<unknown> {
    const session = await this.authenticate(token);
    const result = await this.runtime.resources.read(session, {
      resourceId,
      ...(revisionId === undefined ? {} : { revisionId }),
    });
    const content = Buffer.from(result.content).toString("base64");
    return {
      resource: result.resource,
      revisionId: result.revisionId,
      contentBase64: content,
    };
  }

  async writeMemory(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<CloudMemoryWriteResult> {
    assertNoIdentityOverride(payload);
    const session = await this.authenticate(token);
    const request: CloudMemoryWriteCommand = {
      subject: gatewaySubject(session),
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      branchRef: branchRef(payload),
      action: stringValue(payload, "action") as MemoryAction,
      resourceKind: stringValue(payload, "resourceKind") as MemoryObjectKind,
      clientMutationId: stringValue(payload, "clientMutationId"),
      ...(optionalString(payload, "expectedHeadCommitId") === undefined
        ? {}
        : {
            expectedHeadCommitId: optionalString(
              payload,
              "expectedHeadCommitId",
            ) as string,
          }),
      commit: objectValue(payload, "commit") as CloudMemoryWriteCommand["commit"],
      operation: objectValue(
        payload,
        "operation",
      ) as CloudMemoryWriteCommand["operation"],
    };
    const result = unwrap(await this.writeRouter.execute(request));
    if (result.status === "conflict") {
      throw new TeamMemoryGatewayError(
        "conflict",
        result.conflict.id,
      );
    }
    return result;
  }

  async searchMemory(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<PermissionRouteResult<MemoryRetrievalResult>> {
    assertNoIdentityOverride(payload);
    const session = await this.authenticate(token);
    const request: MemoryRetrievalRequest = {
      subject: gatewaySubject(session),
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      branchRef: branchRef(payload),
      action: (optionalString(payload, "action") ?? "search") as MemoryAction,
      resourceKind: (optionalString(payload, "resourceKind") ??
        "memory_entity") as MemoryObjectKind,
      query: objectValue(payload, "query") as MemoryRetrievalRequest["query"],
    };
    return this.retrievalRouter.execute(request);
  }

  async listHistory(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<{
    records: ReturnType<TeamMemoryRuntime["history"]["listCommitRecords"]>;
  }> {
    assertNoIdentityOverride(payload);
    const session = await this.authenticate(token);
    const branch = branchRef(payload);
    const decision = await this.runtime.policy.decide({
      subject: gatewaySubject(session),
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      branchRef: branch,
      action: "read",
      resourceKind: "memory_entity",
    });
    if (!decision.allowed) {
      throw new TeamMemoryGatewayError(
        "permission_denied",
        decision.reason,
        decision as PermissionDecision & { allowed: false },
      );
    }
    return {
      records: this.runtime.history.listCommitRecords(
        session.rootEntityId,
        branch,
        numberValue(payload, "afterSequence") ?? 0,
      ),
    };
  }

  async listConflicts(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    assertNoIdentityOverride(payload);
    const session = await this.authenticate(token);
    const branch = branchRef(payload);
    const decision = await this.runtime.policy.decide({
      subject: gatewaySubject(session),
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      branchRef: branch,
      action: "read",
      resourceKind: "memory_entity",
    });
    if (!decision.allowed) {
      throw new TeamMemoryGatewayError(
        "permission_denied",
        decision.reason,
        decision as PermissionDecision & { allowed: false },
      );
    }
    return {
      conflicts: this.runtime.history.listConflicts(
        session.rootEntityId,
        branch,
      ),
    };
  }

  async resolveConflict(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<ConflictResolutionResult> {
    assertNoIdentityOverride(payload);
    const session = await this.authenticate(token);
    const request: ConflictResolutionCommand = {
      subject: gatewaySubject(session),
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      branchRef: branchRef(payload),
      action: "merge",
      resourceKind: "memory_entity",
      clientMutationId: stringValue(payload, "clientMutationId"),
      commit: objectValue(payload, "commit") as ConflictResolutionCommand["commit"],
      conflictIds: (payload.conflictIds as string[] | undefined) ?? [],
      resolutionKind: stringValue(
        payload,
        "resolutionKind",
      ) as ConflictResolutionCommand["resolutionKind"],
    };
    if (payload.manualOperation !== undefined) {
      request.manualOperation =
        payload.manualOperation as NonNullable<
          ConflictResolutionCommand["manualOperation"]
        >;
      request.manualAction = payload.manualAction as MemoryAction;
      request.manualResourceKind = payload.manualResourceKind as MemoryObjectKind;
    }
    return unwrap(await this.resolutionRouter.execute(request));
  }

  async pullSync(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<PermissionRouteResult<AuthorizedSyncBatch>> {
    assertNoIdentityOverride(payload);
    const session = await this.authenticate(token);
    return this.syncRouter.execute({
      subject: gatewaySubject(session),
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      branchRef: branchRef(payload),
      action: "read",
      resourceKind: "memory_entity",
      ...(numberValue(payload, "knownCommitWatermark") === undefined
        ? {}
        : {
            knownCommitWatermark: numberValue(
              payload,
              "knownCommitWatermark",
            ) as number,
          }),
      ...(optionalString(payload, "knownPermissionWatermark") === undefined
        ? {}
        : {
            knownPermissionWatermark: optionalString(
              payload,
              "knownPermissionWatermark",
            ) as string,
          }),
      ...(optionalString(payload, "knownTaskScopeHash") === undefined
        ? {}
        : {
            knownTaskScopeHash: optionalString(
              payload,
              "knownTaskScopeHash",
            ) as string,
          }),
    });
  }
}

export function gatewayErrorFromUnknown(error: unknown): TeamMemoryGatewayError {
  if (error instanceof TeamMemoryGatewayError) return error;
  if (error instanceof ResourceNotFoundError) {
    return new TeamMemoryGatewayError("not_found", error.message);
  }
  if (error instanceof SyntaxError) {
    return new TeamMemoryGatewayError("validation_failed", error.message);
  }
  return new TeamMemoryGatewayError(
    "validation_failed",
    error instanceof Error ? error.message : "invalid request",
  );
}
