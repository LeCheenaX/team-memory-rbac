import type {
  AgentDelegation,
  MemoryAction,
  Permission,
  PermissionAuditLog,
  PermissionConstraint,
  PermissionDecision,
  PermissionDecisionCache,
  PermissionRequest,
  PolicyEngine,
  RbacAuthority,
  Role,
  TaskScope,
  UserRootRoleAssignment,
} from "../contracts/rbac.ts";
import { isAdminMemoryAction } from "../contracts/rbac.ts";
import { normalizePermissionConstraints } from "./permissions.ts";

export interface ScopedPolicyEngineOptions {
  now?: () => Date;
  cache?: PermissionDecisionCache;
  auditLog?: PermissionAuditLog;
}

interface UserPermissionAtRoot {
  permission: Permission;
  role: Role;
}

function subjectId(request: PermissionRequest): string {
  return request.subject.kind === "user"
    ? request.subject.userId
    : request.subject.agentId;
}

function isActiveAt(
  record: {
    status: "active" | "revoked";
    expiresAt?: string;
  },
  now: Date,
): boolean {
  return (
    record.status === "active" &&
    (record.expiresAt === undefined ||
      new Date(record.expiresAt).getTime() > now.getTime())
  );
}

function decision(
  request: PermissionRequest,
  allowed: boolean,
  reason: string,
  matchedRoles: string[] = [],
  constraints: PermissionConstraint = {},
): PermissionDecision {
  return {
    allowed,
    reason,
    subjectId: subjectId(request),
    subjectKind: request.subject.kind,
    rootEntityId: request.rootEntityId,
    action: request.action,
    resourceKind: request.resourceKind,
    matchedRoles,
    missingActions: allowed
      ? []
      : [request.action] satisfies MemoryAction[],
    constraints,
  };
}

function intersection<T>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
): T[] | undefined {
  if (left === undefined) {
    return right === undefined ? undefined : [...right];
  }
  if (right === undefined) {
    return [...left];
  }
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function union<T>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
): T[] | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }
  return [...new Set([...(left ?? []), ...(right ?? [])])];
}

function minimum(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return Math.min(left, right);
}

function intersectConstraints(
  left: PermissionConstraint = {},
  right: PermissionConstraint = {},
): PermissionConstraint {
  const allowedTags = intersection(left.allowedTags, right.allowedTags);
  const requiredTags = union(left.requiredTags, right.requiredTags);
  const deniedTags = union(left.deniedTags, right.deniedTags);
  const allowedRelationTypes = intersection(
    left.allowedRelationTypes,
    right.allowedRelationTypes,
  );
  const deniedRelationTypes = union(
    left.deniedRelationTypes,
    right.deniedRelationTypes,
  );
  const maxRelationExpansionDepth = minimum(
    left.maxRelationExpansionDepth,
    right.maxRelationExpansionDepth,
  );

  return {
    ...(allowedTags === undefined ? {} : { allowedTags }),
    ...(requiredTags === undefined ? {} : { requiredTags }),
    ...(deniedTags === undefined ? {} : { deniedTags }),
    ...(allowedRelationTypes === undefined
      ? {}
      : { allowedRelationTypes }),
    ...(deniedRelationTypes === undefined
      ? {}
      : { deniedRelationTypes }),
    ...(maxRelationExpansionDepth === undefined
      ? {}
      : { maxRelationExpansionDepth }),
    ...(left.allowRootEntityMutation === undefined &&
    right.allowRootEntityMutation === undefined
      ? {}
      : {
          allowRootEntityMutation:
            left.allowRootEntityMutation === true &&
            right.allowRootEntityMutation === true,
        }),
    ...(left.requireHumanApproval === true ||
    right.requireHumanApproval === true
      ? { requireHumanApproval: true }
      : {}),
  };
}

function unionAllowed<T>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
): T[] | undefined {
  if (left === undefined || right === undefined) {
    return undefined;
  }
  return union(left, right);
}

function intersectDenied<T>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
): T[] | undefined {
  if (left === undefined || right === undefined) {
    return undefined;
  }
  return intersection(left, right);
}

function maximumGrant(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined || right === undefined) {
    return undefined;
  }
  return Math.max(left, right);
}

function unionGrantConstraints(
  left: PermissionConstraint,
  right: PermissionConstraint,
): PermissionConstraint {
  const allowedTags = unionAllowed(left.allowedTags, right.allowedTags);
  const requiredTags = intersectDenied(left.requiredTags, right.requiredTags);
  const deniedTags = intersectDenied(left.deniedTags, right.deniedTags);
  const allowedRelationTypes = unionAllowed(
    left.allowedRelationTypes,
    right.allowedRelationTypes,
  );
  const deniedRelationTypes = intersectDenied(
    left.deniedRelationTypes,
    right.deniedRelationTypes,
  );
  const maxRelationExpansionDepth = maximumGrant(
    left.maxRelationExpansionDepth,
    right.maxRelationExpansionDepth,
  );

  return {
    ...(allowedTags === undefined ? {} : { allowedTags }),
    ...(requiredTags === undefined ? {} : { requiredTags }),
    ...(deniedTags === undefined ? {} : { deniedTags }),
    ...(allowedRelationTypes === undefined
      ? {}
      : { allowedRelationTypes }),
    ...(deniedRelationTypes === undefined
      ? {}
      : { deniedRelationTypes }),
    ...(maxRelationExpansionDepth === undefined
      ? {}
      : { maxRelationExpansionDepth }),
    ...(left.allowRootEntityMutation === true ||
    right.allowRootEntityMutation === true
      ? { allowRootEntityMutation: true }
      : {}),
    ...(left.requireHumanApproval === true &&
    right.requireHumanApproval === true
      ? { requireHumanApproval: true }
      : {}),
  };
}

function combineAlternativeGrants(
  constraints: readonly PermissionConstraint[],
): PermissionConstraint {
  const first = constraints[0];
  if (first === undefined) {
    return {};
  }
  return constraints
    .slice(1)
    .reduce(unionGrantConstraints, first);
}

function taskScopeConstraints(taskScope: TaskScope): PermissionConstraint {
  return {
    ...(taskScope.allowedTags === undefined
      ? {}
      : { allowedTags: taskScope.allowedTags }),
    ...(taskScope.deniedTags === undefined
      ? {}
      : { deniedTags: taskScope.deniedTags }),
    ...(taskScope.relationExpansionPolicy?.allowedRelationTypes ===
    undefined
      ? {}
      : {
          allowedRelationTypes:
            taskScope.relationExpansionPolicy.allowedRelationTypes,
        }),
    ...(taskScope.relationExpansionPolicy?.maxDepth === undefined
      ? {}
      : {
          maxRelationExpansionDepth:
            taskScope.relationExpansionPolicy.maxDepth,
        }),
  };
}

function rolePermissionConstraints(
  role: Role,
  permission: Permission,
): PermissionConstraint {
  return normalizePermissionConstraints(permission, {
    allowRootEntityMutation: role.id === "role-root-admin",
  });
}

function valuesWithinAllowed<T>(
  values: readonly T[] | undefined,
  allowed: readonly T[] | undefined,
): boolean {
  if (values === undefined || allowed === undefined) {
    return true;
  }
  const allowedSet = new Set(allowed);
  return values.every((value) => allowedSet.has(value));
}

function valuesOutsideDenied<T>(
  values: readonly T[] | undefined,
  denied: readonly T[] | undefined,
): boolean {
  if (values === undefined || denied === undefined) {
    return true;
  }
  const deniedSet = new Set(denied);
  return values.every((value) => !deniedSet.has(value));
}

function valuesIncludeRequired<T>(
  values: readonly T[] | undefined,
  required: readonly T[] | undefined,
): boolean {
  if (required === undefined || required.length === 0) {
    return true;
  }
  if (values === undefined) {
    return false;
  }
  const valueSet = new Set(values);
  return required.every((value) => valueSet.has(value));
}

function requestWithinConstraints(
  request: PermissionRequest,
  constraints: PermissionConstraint,
): boolean {
  if (
    isAdminMemoryAction(request.action) &&
    constraints.allowRootEntityMutation !== true
  ) {
    return false;
  }
  if (
    !valuesWithinAllowed(request.tags, constraints.allowedTags) ||
    !valuesIncludeRequired(request.tags, constraints.requiredTags) ||
    !valuesOutsideDenied(request.tags, constraints.deniedTags)
  ) {
    return false;
  }
  if (
    request.relationType !== undefined &&
    (!valuesWithinAllowed(
      [request.relationType],
      constraints.allowedRelationTypes,
    ) ||
      !valuesOutsideDenied(
        [request.relationType],
        constraints.deniedRelationTypes,
      ))
  ) {
    return false;
  }
  if (
    request.relationDepth !== undefined &&
    constraints.maxRelationExpansionDepth !== undefined &&
    request.relationDepth > constraints.maxRelationExpansionDepth
  ) {
    return false;
  }
  return true;
}

function requestWithinTaskScope(
  request: PermissionRequest,
  taskScope: TaskScope,
): boolean {
  if (taskScope.rootEntityId !== request.rootEntityId) {
    return false;
  }
  if (
    request.entityId !== undefined &&
    ((taskScope.allowedEntityIds !== undefined &&
      !taskScope.allowedEntityIds.includes(request.entityId)) ||
      taskScope.deniedEntityIds?.includes(request.entityId) === true)
  ) {
    return false;
  }
  if (
    request.resourceId !== undefined &&
    ((taskScope.allowedResourceIds !== undefined &&
      !taskScope.allowedResourceIds.includes(request.resourceId)) ||
      taskScope.deniedResourceIds?.includes(request.resourceId) === true)
  ) {
    return false;
  }
  return requestWithinConstraints(
    request,
    taskScopeConstraints(taskScope),
  );
}

export class ScopedPolicyEngine implements PolicyEngine {
  private readonly authority: RbacAuthority;
  private readonly now: () => Date;
  private readonly cache: PermissionDecisionCache | undefined;
  private readonly auditLog: PermissionAuditLog | undefined;

  constructor(
    authority: RbacAuthority,
    options: ScopedPolicyEngineOptions = {},
  ) {
    this.authority = authority;
    this.now = options.now ?? (() => new Date());
    this.cache = options.cache;
    this.auditLog = options.auditLog;
  }

  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    const cached = await this.cache?.get(request);
    const result = cached ?? (await this.decideUncached(request));

    if (cached === undefined) {
      await this.cache?.set(request, result);
    }
    await this.auditLog?.record(request, result);

    return result;
  }

  private async decideUncached(
    request: PermissionRequest,
  ): Promise<PermissionDecision> {
    if (request.subject.kind === "agent") {
      return this.decideAgent(request);
    }

    const user = await this.authority.getUser(request.subject.userId);
    if (user === undefined || user.status !== "active") {
      return decision(request, false, "subject_inactive");
    }

    if (
      request.taskScope !== undefined &&
      !requestWithinTaskScope(request, request.taskScope)
    ) {
      return decision(request, false, "outside_task_scope");
    }

    const permissions = await this.userPermissionsAtRoot(
      request.subject.userId,
      request.rootEntityId,
    );
    const permissionMatches = permissions.filter(
      ({ permission }) =>
        permission.action === request.action &&
        permission.resourceKind === request.resourceKind,
    );
    const matches = permissionMatches.filter(({ role, permission }) =>
      requestWithinConstraints(
        request,
        rolePermissionConstraints(role, permission),
      ),
    );

    if (matches.length === 0) {
      return decision(
        request,
        false,
        permissionMatches.length === 0
          ? "missing_permission"
          : "permission_constraint",
      );
    }

    return decision(
      request,
      true,
      "allowed_by_role",
      matches.map(({ role }) => role.id),
      request.taskScope === undefined
        ? combineAlternativeGrants(
            matches.map(
              ({ role, permission }) =>
                rolePermissionConstraints(role, permission),
            ),
          )
        : intersectConstraints(
            combineAlternativeGrants(
              matches.map(
                ({ role, permission }) =>
                  rolePermissionConstraints(role, permission),
              ),
            ),
            taskScopeConstraints(request.taskScope),
          ),
    );
  }

  private async decideAgent(
    request: PermissionRequest,
  ): Promise<PermissionDecision> {
    if (request.subject.kind !== "agent") {
      return decision(request, false, "invalid_agent_request");
    }

    const agent = await this.authority.getAgent(request.subject.agentId);
    if (
      agent === undefined ||
      agent.status !== "active" ||
      agent.ownerUserId !== request.subject.ownerUserId
    ) {
      return decision(request, false, "subject_inactive");
    }

    const owner = await this.authority.getUser(agent.ownerUserId);
    if (owner === undefined || owner.status !== "active") {
      return decision(request, false, "owner_inactive");
    }

    if (isAdminMemoryAction(request.action)) {
      return decision(
        request,
        false,
        "agent_admin_action_forbidden",
      );
    }

    if (request.taskScope === undefined) {
      return decision(request, false, "missing_task_scope");
    }
    if (!requestWithinTaskScope(request, request.taskScope)) {
      return decision(request, false, "outside_task_scope");
    }

    const ownerPermissions = (
      await this.userPermissionsAtRoot(
        agent.ownerUserId,
        request.rootEntityId,
      )
    ).filter(
      ({ permission }) =>
        permission.action === request.action &&
        permission.resourceKind === request.resourceKind,
    );
    if (ownerPermissions.length === 0) {
      return decision(request, false, "owner_missing_permission");
    }

    const delegations = (
      await this.authority.listAgentDelegations(
        agent.id,
        request.rootEntityId,
      )
    ).filter(
      (delegation) =>
        delegation.ownerUserId === agent.ownerUserId &&
        isActiveAt(delegation, this.now()),
    );

    const delegationMatches = delegations.flatMap((delegation) =>
      this.delegatedPermissionsForRequest(delegation, request),
    );
    if (delegationMatches.length === 0) {
      return decision(request, false, "missing_delegation");
    }

    const effectiveGrants: PermissionConstraint[] = [];
    const matchedRoleIds = new Set<string>();

    for (const ownerPermission of ownerPermissions) {
      for (const delegated of delegationMatches) {
        const effectiveConstraints = intersectConstraints(
          intersectConstraints(
            rolePermissionConstraints(
              ownerPermission.role,
              ownerPermission.permission,
            ),
            normalizePermissionConstraints(delegated.permission),
          ),
          taskScopeConstraints(request.taskScope),
        );

        if (requestWithinConstraints(request, effectiveConstraints)) {
          effectiveGrants.push(effectiveConstraints);
          matchedRoleIds.add(ownerPermission.role.id);
        }
      }
    }

    if (effectiveGrants.length > 0) {
      return decision(
        request,
        true,
        "allowed_by_delegation",
        [...matchedRoleIds],
        combineAlternativeGrants(effectiveGrants),
      );
    }

    return decision(request, false, "delegation_constraint");
  }

  private delegatedPermissionsForRequest(
    delegation: AgentDelegation,
    request: PermissionRequest,
  ): Array<{
    delegation: AgentDelegation;
    permission: Permission;
  }> {
    return delegation.permissions
      .filter(
        (permission) =>
          permission.action === request.action &&
          permission.resourceKind === request.resourceKind,
      )
      .map((permission) => ({
        delegation,
        permission,
      }));
  }

  private async userPermissionsAtRoot(
    userId: string,
    rootEntityId: string,
  ): Promise<UserPermissionAtRoot[]> {
    const assignments =
      await this.authority.listUserRootRoleAssignments(
        userId,
        rootEntityId,
      );
    const activeAssignments = assignments.filter((assignment) =>
      isActiveAt(assignment, this.now()),
    );

    const roles = await Promise.all(
      activeAssignments.map((assignment) =>
        this.roleForAssignment(assignment),
      ),
    );

    return roles.flatMap((role) =>
      role === undefined
        ? []
        : role.permissions.map((permission) => ({
            permission,
            role,
          })),
    );
  }

  private async roleForAssignment(
    assignment: UserRootRoleAssignment,
  ): Promise<Role | undefined> {
    const role = await this.authority.getRole(assignment.roleId);
    return role?.status === "active" ? role : undefined;
  }
}
