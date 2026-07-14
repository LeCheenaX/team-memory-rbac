import type {
  AgentDelegation,
  MemoryAction,
  Permission,
  PermissionConstraint,
  PermissionDecision,
  PolicyEngine,
  PrincipalContext,
  Role,
  TaskScope,
} from "../contracts/rbac.ts";
import {
  isAdminMemoryAction,
} from "../contracts/rbac.ts";
import type {
  MemoryObjectKind,
} from "../contracts/memory.ts";
import type {
  PermissionRouteResult,
} from "../permission-router.ts";
import {
  validateAgentDelegation,
} from "../rbac/validation.ts";
import {
  normalizePermissionConstraints,
} from "../rbac/permissions.ts";
import type {
  AgentSessionAuthority,
  SessionPermissionInput,
} from "./session.ts";
import {
  permissionRequestFromPrincipal,
} from "./session.ts";

export interface SessionAuthorization {
  principal: PrincipalContext;
  decision: PermissionDecision & { allowed: true };
}

export class SessionMemorySdk {
  private readonly sessions: AgentSessionAuthority;
  private readonly policy: PolicyEngine;

  constructor(
    sessions: AgentSessionAuthority,
    policy: PolicyEngine,
  ) {
    this.sessions = sessions;
    this.policy = policy;
  }

  async authorize(
    token: string,
    input: SessionPermissionInput,
  ): Promise<
    | SessionAuthorization
    | { decision: PermissionDecision & { allowed: false } }
  > {
    const principal = await this.sessions.resolve(token);
    const decision = await this.policy.decide(
      permissionRequestFromPrincipal(principal, input),
    );
    return decision.allowed
      ? {
          principal,
          decision: decision as PermissionDecision & { allowed: true },
        }
      : {
          decision: decision as PermissionDecision & { allowed: false },
        };
  }

  async execute<TResult>(
    token: string,
    input: SessionPermissionInput,
    handler: (
      authorization: SessionAuthorization,
    ) => Promise<TResult>,
  ): Promise<PermissionRouteResult<TResult>> {
    const authorization = await this.authorize(token, input);
    if (!("principal" in authorization)) {
      return { decision: authorization.decision };
    }
    return {
      decision: authorization.decision,
      value: await handler(authorization),
    };
  }
}

export interface AgentToolDefinition<
  TInput = Record<string, unknown>,
  TResult = unknown,
> {
  name: string;
  description: string;
  action: MemoryAction;
  resourceKind: MemoryObjectKind;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  permissionInput?: (
    input: TInput,
  ) => Omit<Partial<SessionPermissionInput>, "action" | "resourceKind">;
  execute(
    principal: PrincipalContext,
    input: TInput,
  ): Promise<TResult>;
}

export interface VisibleAgentTool {
  name: string;
  description: string;
  inputSchema: AgentToolDefinition["inputSchema"];
}

const forbiddenToolFields = new Set([
  "subject",
  "userId",
  "ownerUserId",
  "agentId",
  "rootEntityId",
  "taskScope",
]);

function assertSafeToolSchema(tool: AgentToolDefinition): void {
  for (const field of Object.keys(tool.inputSchema.properties ?? {})) {
    if (forbiddenToolFields.has(field)) {
      throw new Error(
        `tool ${tool.name} schema exposes forbidden identity field ${field}`,
      );
    }
  }
}

export class ToolPermissionAdapter {
  private readonly sdk: SessionMemorySdk;
  private readonly tools: Map<string, AgentToolDefinition>;

  constructor(
    sdk: SessionMemorySdk,
    tools: AgentToolDefinition[],
  ) {
    for (const tool of tools) {
      assertSafeToolSchema(tool);
    }
    this.sdk = sdk;
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  async listVisibleTools(token: string): Promise<VisibleAgentTool[]> {
    const visible: VisibleAgentTool[] = [];
    for (const tool of this.tools.values()) {
      if (isAdminMemoryAction(tool.action)) continue;
      const authorization = await this.sdk.authorize(token, {
        action: tool.action,
        resourceKind: tool.resourceKind,
      });
      if ("principal" in authorization) {
        visible.push({
          name: tool.name,
          description: tool.description,
          inputSchema: structuredClone(tool.inputSchema),
        });
      }
    }
    return visible;
  }

  async invoke(
    token: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionRouteResult<unknown>> {
    const tool = this.tools.get(toolName);
    if (tool === undefined) {
      throw new Error(`unknown tool: ${toolName}`);
    }
    for (const field of forbiddenToolFields) {
      if (field in input) {
        throw new Error(`tool input cannot provide ${field}`);
      }
    }
    const additional = tool.permissionInput?.(input) ?? {};
    return this.sdk.execute(
      token,
      {
        ...additional,
        action: tool.action,
        resourceKind: tool.resourceKind,
      },
      ({ principal }) => tool.execute(principal, input),
    );
  }
}

function scopeConstraints(taskScope: TaskScope): PermissionConstraint {
  return {
    ...(taskScope.allowedTags === undefined
      ? {}
      : { allowedTags: [...taskScope.allowedTags] }),
    ...(taskScope.deniedTags === undefined
      ? {}
      : { deniedTags: [...taskScope.deniedTags] }),
    ...(taskScope.relationExpansionPolicy?.allowedRelationTypes ===
    undefined
      ? {}
      : {
          allowedRelationTypes: [
            ...taskScope.relationExpansionPolicy.allowedRelationTypes,
          ],
        }),
    ...(taskScope.relationExpansionPolicy?.maxDepth === undefined
      ? {}
      : {
          maxRelationExpansionDepth:
            taskScope.relationExpansionPolicy.maxDepth,
        }),
  };
}

function scopedPermissions(
  permissions: Permission[],
  taskScope: TaskScope,
): Permission[] {
  const scope = scopeConstraints(taskScope) ?? {};
  const intersection = <T>(
    left: T[] | undefined,
    right: T[] | undefined,
  ): T[] | undefined => {
    if (left === undefined) return right;
    if (right === undefined) return left;
    return left.filter((value) => right.includes(value));
  };
  const union = <T>(
    left: T[] | undefined,
    right: T[] | undefined,
  ): T[] | undefined =>
    left === undefined && right === undefined
      ? undefined
      : [...new Set([...(left ?? []), ...(right ?? [])])];
  return permissions.map((permission) => ({
    ...structuredClone(permission),
    ...(() => {
      const original = normalizePermissionConstraints(permission);
      const allowedTags = intersection(
        original.allowedTags,
        scope.allowedTags,
      );
      const deniedTags = union(
        original.deniedTags,
        scope.deniedTags,
      );
      const requiredTags = union(
        original.requiredTags,
        scope.requiredTags,
      );
      const allowedRelationTypes = intersection(
        original.allowedRelationTypes,
        scope.allowedRelationTypes,
      );
      const deniedRelationTypes = union(
        original.deniedRelationTypes,
        scope.deniedRelationTypes,
      );
      const leftDepth = original.maxRelationExpansionDepth;
      const rightDepth = scope.maxRelationExpansionDepth;
      const maxRelationExpansionDepth =
        leftDepth === undefined
          ? rightDepth
          : rightDepth === undefined
            ? leftDepth
            : Math.min(leftDepth, rightDepth);
      const constraints = {
        ...(allowedTags === undefined ? {} : { allowedTags }),
        ...(deniedTags === undefined ? {} : { deniedTags }),
        ...(requiredTags === undefined ? {} : { requiredTags }),
        ...(allowedRelationTypes === undefined
          ? {}
          : { allowedRelationTypes }),
        ...(deniedRelationTypes === undefined
          ? {}
          : { deniedRelationTypes }),
        ...(maxRelationExpansionDepth === undefined
          ? {}
          : { maxRelationExpansionDepth }),
        ...(original.requireHumanApproval === true
          ? { requireHumanApproval: true }
          : {}),
      };
      return Object.keys(constraints).length === 0
        ? {}
        : {
            ...(constraints.allowedTags === undefined
              ? {}
              : { tagsAny: constraints.allowedTags }),
            ...(constraints.requiredTags === undefined
              ? {}
              : { tagsAll: constraints.requiredTags }),
            ...(constraints.allowedRelationTypes === undefined
              ? {}
              : { relationTypes: constraints.allowedRelationTypes }),
          };
    })(),
  }));
}

export interface CreateSubAgentDelegationInput {
  id: string;
  childAgentId?: string;
  ownerUserId: string;
  parentAgentId?: string;
  rootEntityId: string;
  requestedPermissions: Permission[];
  ownerPermissions: Permission[];
  parentPermissions: Permission[];
  taskScope: TaskScope;
  delegatedAt: string;
  expiresAt?: string;
}

export function createSubAgentDelegation(
  input: CreateSubAgentDelegationInput,
): AgentDelegation {
  if (input.taskScope.rootEntityId !== input.rootEntityId) {
    throw new Error("subagent TaskScope root mismatch");
  }
  if (
    input.requestedPermissions.some((permission) =>
      isAdminMemoryAction(permission.action),
    )
  ) {
    throw new Error("administrator permissions cannot be delegated to agents");
  }
  const delegation: AgentDelegation = {
    id: input.id,
    ...(input.childAgentId === undefined
      ? {}
      : { agentId: input.childAgentId }),
    ownerUserId: input.ownerUserId,
    rootEntityId: input.rootEntityId,
    permissions: scopedPermissions(
      input.requestedPermissions,
      input.taskScope,
    ),
    delegatedBy: input.parentAgentId ?? input.ownerUserId,
    delegatedAt: input.delegatedAt,
    status: "active",
    ...(input.expiresAt === undefined
      ? {}
      : { expiresAt: input.expiresAt }),
  };
  validateAgentDelegation(delegation, input.ownerPermissions);
  validateAgentDelegation(delegation, input.parentPermissions);
  return delegation;
}

export interface TaskPermissionAnalysis {
  requiredPermissions: Permission[];
  grantedPermissions: Permission[];
  missingPermissions: Permission[];
  satisfyingRoles: string[];
  requiresHumanApproval: boolean;
}

function permissionKey(permission: Permission): string {
  return `${permission.action}:${permission.resourceKind}`;
}

function roleSatisfies(role: Role, required: Permission[]): boolean {
  return required.every((permission) =>
    role.permissions.some((candidate) => {
      if (
        candidate.action !== permission.action ||
        candidate.resourceKind !== permission.resourceKind
      ) {
        return false;
      }
      if (
        permission.tagsAny === undefined &&
        permission.tagsAll === undefined &&
        permission.relationTypes === undefined &&
        permission.taskScope === undefined
      ) {
        return true;
      }
      try {
        validateAgentDelegation(
          {
            id: "analysis",
            ownerUserId: "analysis",
            rootEntityId: "analysis",
            permissions: [structuredClone(permission)],
            delegatedBy: "analysis",
            delegatedAt: "1970-01-01T00:00:00.000Z",
            status: "active",
          },
          [candidate],
        );
        return true;
      } catch {
        return false;
      }
    }),
  );
}

function decisionCoversPermission(
  permission: Permission,
  decision: PermissionDecision,
): boolean {
  if (!decision.allowed) return false;
  try {
    validateAgentDelegation(
      {
        id: "analysis",
        ownerUserId: decision.subjectId,
        rootEntityId: decision.rootEntityId,
        permissions: [structuredClone(permission)],
        delegatedBy: decision.subjectId,
        delegatedAt: "1970-01-01T00:00:00.000Z",
        status: "active",
      },
      [
        {
          action: permission.action,
          resourceKind: permission.resourceKind,
          ...(Object.keys(decision.constraints).length === 0
            ? {}
            : {
                tagsAny: decision.constraints.allowedTags,
                tagsAll: decision.constraints.requiredTags,
                relationTypes: decision.constraints.allowedRelationTypes,
              }),
        },
      ],
    );
    return true;
  } catch {
    return false;
  }
}

export class TaskPermissionAnalyzer {
  private readonly policy: PolicyEngine;
  private readonly roles: readonly Role[];

  constructor(policy: PolicyEngine, roles: readonly Role[]) {
    this.policy = policy;
    this.roles = roles;
  }

  async analyze(
    principal: PrincipalContext,
    requiredPermissions: Permission[],
  ): Promise<TaskPermissionAnalysis> {
    const grantedPermissions: Permission[] = [];
    const missingPermissions: Permission[] = [];
    let requiresHumanApproval = false;

    for (const permission of requiredPermissions) {
      const decision = await this.policy.decide(
        permissionRequestFromPrincipal(principal, {
          action: permission.action,
          resourceKind: permission.resourceKind,
        }),
      );
      if (decisionCoversPermission(permission, decision)) {
        grantedPermissions.push(structuredClone(permission));
      } else {
        missingPermissions.push(structuredClone(permission));
      }
      requiresHumanApproval =
        requiresHumanApproval ||
        isAdminMemoryAction(permission.action) ||
        decision.constraints.requireHumanApproval === true ||
        false;
    }

    return {
      requiredPermissions: structuredClone(requiredPermissions),
      grantedPermissions,
      missingPermissions,
      satisfyingRoles: this.roles
        .filter(
          (role) =>
            role.status === "active" &&
            roleSatisfies(role, requiredPermissions),
        )
        .map((role) => role.id),
      requiresHumanApproval,
    };
  }

  summarizeMissing(analysis: TaskPermissionAnalysis): string[] {
    return analysis.missingPermissions.map(permissionKey);
  }
}
