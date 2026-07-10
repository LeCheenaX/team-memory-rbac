import { randomUUID } from "node:crypto";
import { ResourceConflictError, ResourceNotFoundError } from "../../resources/service.ts";
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
import type { AgentDelegation, User, UserRootRoleAssignment } from "../../contracts/rbac.ts";
import type { AgentType, Permission } from "../../contracts/rbac.ts";
import type { AuthenticatedSession } from "../libsql/rbac-authority.ts";
import type { CreatedSession } from "../libsql/rbac-authority.ts";
import {
  formatInjectedMemoryContext,
  hostCaptureInput,
  hostRecallInput,
  type HostCaptureInput,
  type HostRecallInput,
  type InjectedMemoryContext,
  type MemoryCaptureResult,
} from "../lifecycle/host-memory.ts";
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

function recallSearchText(input: HostRecallInput): string {
  return [
    input.userPrompt,
    ...(input.recentMessages ?? []).slice(-6).map((message) =>
      `${message.role}: ${message.content}`
    ),
    ...(input.resourceHints ?? []),
  ].join("\n");
}

function captureTitle(input: HostCaptureInput): string {
  const subject = input.userPrompt ?? input.finalAssistantMessage ?? input.errorSummary;
  const trimmed = subject?.replace(/\s+/g, " ").trim();
  const suffix = trimmed === undefined || trimmed.length === 0
    ? input.sessionId
    : trimmed.slice(0, 80);
  return `${input.host} ${input.outcome} path: ${suffix}`;
}

function captureDescription(input: HostCaptureInput): string {
  const lines = [
    `Host: ${input.host}`,
    `Session: ${input.sessionId}`,
    `Outcome: ${input.outcome}`,
    input.userPrompt === undefined ? "" : `User prompt: ${input.userPrompt}`,
    input.finalAssistantMessage === undefined
      ? ""
      : `Final assistant message: ${input.finalAssistantMessage}`,
    input.errorSummary === undefined ? "" : `Error summary: ${input.errorSummary}`,
    input.transcriptPath === undefined ? "" : `Transcript: ${input.transcriptPath}`,
    input.toolEvents === undefined
      ? ""
      : `Tool events: ${JSON.stringify(input.toolEvents)}`,
  ];
  return lines.filter((line) => line.length > 0).join("\n");
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
  { name: "memory.catalog", description: "List visible memory entities and tags", action: "read", resourceKind: "memory_entity" },
  { name: "memory.search", description: "Search memory", action: "search", resourceKind: "memory_entity" },
  { name: "memory.write", description: "Capture or update memory", action: "write_entity", resourceKind: "memory_entity" },
] as const;

const stableCatalogFields = new Set<string>();
const stableSearchFields = new Set([
  "query",
  "limit",
  "layer",
  "names",
  "tagsAny",
]);

function assertOnlyFields(
  payload: Record<string, unknown>,
  allowed: Set<string>,
  surface: string,
): void {
  for (const field of Object.keys(payload)) {
    if (!allowed.has(field)) {
      throw new TeamMemoryGatewayError(
        "validation_failed",
        `${surface} payload cannot provide ${field}`,
      );
    }
  }
}

function optionalStringList(
  payload: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new TeamMemoryGatewayError(
      "validation_failed",
      `${key} must be an array of non-empty strings`,
    );
  }
  return value;
}

function optionalRecallLayer(
  payload: Record<string, unknown>,
): "L1" | "L2" | "L3" | undefined {
  const value = payload.layer;
  if (value === undefined) return undefined;
  if (value === "L1" || value === "L2" || value === "L3") {
    return value;
  }
  throw new TeamMemoryGatewayError(
    "validation_failed",
    "layer must be L1, L2, or L3",
  );
}

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

  async createMember(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<{
    user: User;
    assignment?: UserRootRoleAssignment;
  }> {
    const session = await this.authenticate(token);
    return this.runtime.admin.createUser(session, {
      userId: stringValue(payload, "userId"),
      displayName: stringValue(payload, "displayName"),
      password: stringValue(payload, "password"),
      ...(optionalString(payload, "roleId") === undefined
        ? {}
        : { roleId: optionalString(payload, "roleId") as string }),
    });
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
      ...(typeof payload.revisionId === "string"
        ? { revisionId: payload.revisionId }
        : {}),
      ...(typeof payload.commitId === "string"
        ? { commitId: payload.commitId }
        : {}),
      ...(typeof payload.branchRef === "string"
        ? { branchRef: payload.branchRef }
        : {}),
      ...(typeof payload.expectedHeadCommitId === "string"
        ? { expectedHeadCommitId: payload.expectedHeadCommitId }
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
      ...(typeof payload.revisionId === "string"
        ? { revisionId: payload.revisionId }
        : {}),
      ...(typeof payload.commitId === "string"
        ? { commitId: payload.commitId }
        : {}),
      ...(typeof payload.branchRef === "string"
        ? { branchRef: payload.branchRef }
        : {}),
      ...(typeof payload.expectedHeadCommitId === "string"
        ? { expectedHeadCommitId: payload.expectedHeadCommitId }
        : {}),
      ...(typeof payload.metadata === "object" && payload.metadata !== null
        ? { metadata: payload.metadata as Record<string, unknown> }
        : {}),
    });
  }

  async ingestResource(
    token: string | undefined,
    resourceId: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    assertNoIdentityOverride(payload);
    const session = await this.authenticate(token);
    return this.runtime.ingestion.ingest(session, {
      resourceId,
      clientMutationId: stringValue(payload, "clientMutationId"),
      ...(typeof payload.revisionId === "string"
        ? { revisionId: payload.revisionId }
        : {}),
      ...(typeof payload.branchRef === "string"
        ? { branchRef: payload.branchRef }
        : {}),
      ...(typeof payload.maxChunkCharacters === "number"
        ? { maxChunkCharacters: payload.maxChunkCharacters }
        : {}),
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

  async memoryCatalog(
    token: string | undefined,
    payload: Record<string, unknown> = {},
  ): Promise<{
    rootName: string;
    branchRef: string;
    entities: Array<{
      name: string;
      status: string;
      tags: string[];
    }>;
    tags: Array<{
      tag: string;
      count: number;
      names: string[];
    }>;
  }> {
    assertNoIdentityOverride(payload);
    assertOnlyFields(payload, stableCatalogFields, "memory.catalog");
    const session = await this.authenticate(token);
    const branch = "main";
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

    const view = this.runtime.history.readActiveView(session.rootEntityId, branch);
    const branchById = new Map(view.entityBranches.map((candidate) => [
      candidate.id,
      candidate,
    ]));
    const rootEntity = view.entities.find(
      (entity) => entity.id === session.rootEntityId && entity.rootEntityId === null,
    );
    const rootBranch = rootEntity?.currentBranchId === undefined
      ? undefined
      : branchById.get(rootEntity.currentBranchId);
    const visibleEntities = view.entities
      .filter((entity) => entity.rootEntityId !== null)
      .filter((entity) =>
        session.taskScope.allowedEntityIds === undefined ||
        session.taskScope.allowedEntityIds.includes(entity.id)
      )
      .filter((entity) =>
        session.taskScope.deniedEntityIds?.includes(entity.id) !== true
      )
      .map((entity) => ({
        entity,
        branch: entity.currentBranchId === undefined
          ? undefined
          : branchById.get(entity.currentBranchId),
      }))
      .filter(({ branch }) => {
        const tags = branch?.tags ?? [];
        return (
          (session.taskScope.allowedTags === undefined ||
            tags.some((tag) => session.taskScope.allowedTags?.includes(tag))) &&
          !tags.some((tag) => session.taskScope.deniedTags?.includes(tag))
        );
      });
    const tagMap = new Map<string, Set<string>>();
    for (const { entity, branch } of visibleEntities) {
      const name = branch?.title ?? entity.id;
      for (const tag of branch?.tags ?? []) {
        const names = tagMap.get(tag) ?? new Set<string>();
        names.add(name);
        tagMap.set(tag, names);
      }
    }
    return {
      rootName: rootBranch?.title ?? session.rootEntityId,
      branchRef: branch,
      entities: visibleEntities.map(({ entity, branch }) => ({
        name: branch?.title ?? entity.id,
        status: entity.status,
        tags: [...(branch?.tags ?? [])],
      })),
      tags: [...tagMap.entries()]
        .map(([tag, names]) => ({
          tag,
          count: names.size,
          names: [...names].sort(),
        }))
        .sort((left, right) => left.tag.localeCompare(right.tag)),
    };
  }

  async writeMemory(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<CloudMemoryWriteResult> {
    assertNoIdentityOverride(payload);
    const session = await this.authenticate(token);
    const branch = branchRef(payload);
    const request: CloudMemoryWriteCommand = {
      subject: gatewaySubject(session),
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      branchRef: branch,
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
    await this.runtime.projectMemory(session.rootEntityId, branch);
    return result;
  }

  async searchMemory(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<PermissionRouteResult<MemoryRetrievalResult>> {
    assertNoIdentityOverride(payload);
    assertOnlyFields(payload, stableSearchFields, "memory.search");
    const session = await this.authenticate(token);
    const text = stringValue(payload, "query");
    const request: MemoryRetrievalRequest = {
      subject: gatewaySubject(session),
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      branchRef: "main",
      action: "search",
      resourceKind: "memory_entity",
      query: {
        kind: "recall",
        text,
        ...(numberValue(payload, "limit") === undefined
          ? {}
          : { limit: numberValue(payload, "limit") as number }),
        ...(optionalRecallLayer(payload) === undefined
          ? {}
          : { layer: optionalRecallLayer(payload) as "L1" | "L2" | "L3" }),
        ...(optionalStringList(payload, "names") === undefined
          ? {}
          : { names: optionalStringList(payload, "names") as string[] }),
        ...(optionalStringList(payload, "tagsAny") === undefined
          ? {}
          : { tagsAny: optionalStringList(payload, "tagsAny") as string[] }),
      },
    };
    return this.retrievalRouter.execute(request);
  }

  async recallHostMemory(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<InjectedMemoryContext> {
    assertNoIdentityOverride(payload);
    const input = hostRecallInput(payload);
    const session = await this.authenticate(token);
    const branch = input.branchRef ?? "main";
    let result = unwrap(await this.retrievalRouter.execute({
      subject: gatewaySubject(session),
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      branchRef: branch,
      action: "search",
      resourceKind: "memory_entity",
      query: {
        kind: "entity",
        text: recallSearchText(input),
        limit: input.limit ?? 8,
      },
    }));
    if (result.items.length === 0) {
      result = unwrap(await this.retrievalRouter.execute({
        subject: gatewaySubject(session),
        rootEntityId: session.rootEntityId,
        taskScope: session.taskScope,
        branchRef: branch,
        action: "search",
        resourceKind: "memory_entity",
        query: {
          kind: "entity",
          limit: input.limit ?? 8,
        },
      }));
    }
    return formatInjectedMemoryContext(input.host, result);
  }

  async captureHostMemory(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<MemoryCaptureResult> {
    assertNoIdentityOverride(payload);
    const input = hostCaptureInput(payload);
    const session = await this.authenticate(token);
    const now = new Date().toISOString();
    const branch = input.branchRef ?? "main";
    const id = randomUUID();
    const entityId = `host-capture:${id}`;
    const branchId = `host-capture-branch:${id}`;
    const entityCommitId = `host-capture-entity-commit:${id}`;
    const branchCommitId = `host-capture-branch-commit:${id}`;
    const branchExtraInfo = {
      host: input.host,
      sessionId: input.sessionId,
      outcome: input.outcome,
      ...(input.userPrompt === undefined ? {} : { userPrompt: input.userPrompt }),
      ...(input.finalAssistantMessage === undefined
        ? {}
        : { finalAssistantMessage: input.finalAssistantMessage }),
      ...(input.transcriptPath === undefined ? {} : { transcriptPath: input.transcriptPath }),
      ...(input.errorSummary === undefined ? {} : { errorSummary: input.errorSummary }),
      ...(input.toolEvents === undefined ? {} : { toolEvents: input.toolEvents }),
    };
    const entityResult = unwrap(await this.writeRouter.execute({
      subject: gatewaySubject(session),
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      branchRef: branch,
      action: "write_entity",
      resourceKind: "memory_entity",
      clientMutationId: `host-capture-entity:${id}`,
      commit: {
        id: entityCommitId,
        message: `Capture ${input.host} ${input.outcome} path`,
      },
      operation: {
        kind: "create_entity",
        id: `host-capture-entity-operation:${id}`,
        entity: {
          id: entityId,
          rootEntityId: session.rootEntityId,
          currentBranchId: branchId,
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      },
    }));
    if (entityResult.status === "conflict") {
      throw new TeamMemoryGatewayError("conflict", entityResult.conflict.id);
    }
    const branchResult = unwrap(await this.writeRouter.execute({
      subject: gatewaySubject(session),
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      branchRef: branch,
      action: "write_entity_branch",
      resourceKind: "memory_entity_branch",
      clientMutationId: `host-capture-branch:${id}`,
      commit: {
        id: branchCommitId,
        message: `Capture ${input.host} ${input.outcome} details`,
      },
      operation: {
        kind: "create_entity_branch",
        id: `host-capture-branch-operation:${id}`,
        branch: {
          id: branchId,
          entityId,
          rootEntityId: session.rootEntityId,
          branchRef: branch,
          title: input.title ?? captureTitle(input),
          description: captureDescription(input),
          tags: ["host-memory", input.host, input.outcome],
          extraInfo: branchExtraInfo,
          importance: input.outcome === "failure" ? 0.9 : 0.75,
          confidence: 0.8,
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      },
    }));
    if (branchResult.status === "conflict") {
      throw new TeamMemoryGatewayError("conflict", branchResult.conflict.id);
    }
    await this.runtime.projectMemory(session.rootEntityId, branch);
    return {
      status: "captured",
      entityId,
      branchId,
      commitIds: [entityCommitId, branchCommitId],
      extra: branchExtraInfo,
    };
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
    const branch = branchRef(payload);
    const request: ConflictResolutionCommand = {
      subject: gatewaySubject(session),
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      branchRef: branch,
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
    const result = unwrap(await this.resolutionRouter.execute(request));
    await this.runtime.projectMemory(session.rootEntityId, branch);
    return result;
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
  if (error instanceof ResourceConflictError) {
    return new TeamMemoryGatewayError("conflict", error.conflictId);
  }
  if (error instanceof SyntaxError) {
    return new TeamMemoryGatewayError("validation_failed", error.message);
  }
  return new TeamMemoryGatewayError(
    "validation_failed",
    error instanceof Error ? error.message : "invalid request",
  );
}
