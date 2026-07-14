import type {
  AgentDelegation,
  Permission,
  PermissionConstraint,
  Role,
} from "../contracts/rbac.ts";
import {
  isPermissionCombinationSupported,
  normalizePermissionConstraints,
} from "./permissions.ts";

function permissionKey(permission: Permission): string {
  return JSON.stringify({
    action: permission.action,
    resourceKind: permission.resourceKind,
    tagsAny: permission.tagsAny ?? [],
    tagsAll: permission.tagsAll ?? [],
    relationTypes: permission.relationTypes ?? [],
    taskScope: permission.taskScope ?? [],
  });
}

function assertNoStaleConstraintPayload(permission: Permission): void {
  if ("constraints" in (permission as unknown as Record<string, unknown>)) {
    throw new Error(
      "permission constraints are internal; use flat Permission fields",
    );
  }
}

function assertConstraint(constraint: PermissionConstraint): void {
  if (
    constraint.requiredTags !== undefined &&
    constraint.requiredTags.length === 0
  ) {
    throw new Error("requiredTags must not be empty");
  }
  if (
    constraint.maxRelationExpansionDepth !== undefined &&
    (!Number.isInteger(constraint.maxRelationExpansionDepth) ||
      constraint.maxRelationExpansionDepth < 0)
  ) {
    throw new Error(
      "maxRelationExpansionDepth must be a non-negative integer",
    );
  }
}

function isSubset<T>(candidate: readonly T[], owner: readonly T[]): boolean {
  const ownerSet = new Set(owner);
  return candidate.every((value) => ownerSet.has(value));
}

function constraintsAreSubset(
  candidate: PermissionConstraint,
  owner: PermissionConstraint,
): boolean {
  if (
    candidate.allowRootEntityMutation === true &&
    owner.allowRootEntityMutation !== true
  ) {
    return false;
  }

  if (
    owner.requireHumanApproval === true &&
    candidate.requireHumanApproval !== true
  ) {
    return false;
  }

  if (
    owner.maxRelationExpansionDepth !== undefined &&
    (candidate.maxRelationExpansionDepth === undefined ||
      candidate.maxRelationExpansionDepth >
        owner.maxRelationExpansionDepth)
  ) {
    return false;
  }

  if (
    owner.allowedTags !== undefined &&
    (candidate.allowedTags === undefined ||
      !isSubset(candidate.allowedTags, owner.allowedTags))
  ) {
    return false;
  }

  if (
    owner.requiredTags !== undefined &&
    (candidate.requiredTags === undefined ||
      !isSubset(owner.requiredTags, candidate.requiredTags))
  ) {
    return false;
  }

  if (
    owner.deniedTags !== undefined &&
    (candidate.deniedTags === undefined ||
      !isSubset(owner.deniedTags, candidate.deniedTags))
  ) {
    return false;
  }

  if (
    owner.allowedRelationTypes !== undefined &&
    (candidate.allowedRelationTypes === undefined ||
      !isSubset(
        candidate.allowedRelationTypes,
        owner.allowedRelationTypes,
      ))
  ) {
    return false;
  }

  if (
    owner.deniedRelationTypes !== undefined &&
    (candidate.deniedRelationTypes === undefined ||
      !isSubset(
        owner.deniedRelationTypes,
        candidate.deniedRelationTypes,
      ))
  ) {
    return false;
  }

  return true;
}

export function validateCustomRole(role: Role): void {
  if (role.kind !== "custom") {
    throw new Error("custom role validation requires kind=custom");
  }
  if (role.id.length === 0 || role.name.length === 0) {
    throw new Error("custom role id and name must be non-empty");
  }
  if (role.permissions.length === 0) {
    throw new Error("custom role must define at least one permission");
  }

  const keys = new Set<string>();
  for (const permission of role.permissions) {
    assertNoStaleConstraintPayload(permission);
    const key = permissionKey(permission);
    if (keys.has(key)) {
      throw new Error(`duplicate permission: ${key}`);
    }
    keys.add(key);
    if (!isPermissionCombinationSupported(permission)) {
      throw new Error(`unsupported permission combination: ${key}`);
    }
    assertConstraint(
      normalizePermissionConstraints(permission, {
        allowRootEntityMutation: role.id === "role-root-admin",
      }),
    );
  }
}

export function validateAgentDelegation(
  delegation: AgentDelegation,
  ownerPermissions: readonly Permission[],
): void {
  if (delegation.permissions.length === 0) {
    throw new Error("agent delegation must contain at least one permission");
  }

  for (const delegatedPermission of delegation.permissions) {
    assertNoStaleConstraintPayload(delegatedPermission);
    const delegatedConstraints =
      normalizePermissionConstraints(delegatedPermission);
    const ownerPermission = ownerPermissions.find(
      (permission) =>
        permission.action === delegatedPermission.action &&
        permission.resourceKind === delegatedPermission.resourceKind,
    );

    if (
      ownerPermission === undefined ||
      !constraintsAreSubset(
        delegatedConstraints,
        normalizePermissionConstraints(ownerPermission),
      )
    ) {
      throw new Error(
        `delegated permission exceeds owner permission: ${permissionKey(
          delegatedPermission,
        )}`,
      );
    }
  }
}
