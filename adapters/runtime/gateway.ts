import { ResourceNotFoundError } from "../../src/resources/service.ts";
import {
  CloudAuthorizedViewAdapter,
  ConflictResolutionAdapter,
  InMemoryAuthorizedQuerySource,
  InMemoryPermissionWatermarkAuthority,
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
  type MemoryRetrievalRequest,
  type MemoryRetrievalResult,
  type PermissionDecision,
  type PermissionRouteResult,
  type ResourceSourceType,
} from "../../src/index.ts";
import type { AuthenticatedSession } from "../libsql/rbac-authority.ts";
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
  permissionWatermarks?: InMemoryPermissionWatermarkAuthority;
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
        options.permissionWatermarks ??
          new InMemoryPermissionWatermarkAuthority(),
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
