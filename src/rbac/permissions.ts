import type { MemoryObjectKind } from "../contracts/memory.ts";
import type {
  MemoryAction,
  Permission,
} from "../contracts/rbac.ts";

export const SUPPORTED_RESOURCE_KINDS_BY_ACTION = {
  read: [
    "memory_entity",
    "memory_entity_branch",
    "memory_relation",
    "resource",
    "resource_chunk",
  ],
  search: [
    "memory_entity",
    "memory_entity_branch",
    "memory_relation",
    "resource",
    "resource_chunk",
  ],
  traverse_relation: ["memory_relation"],
  import_resource: ["resource"],
  write_resource_chunk: ["resource_chunk"],
  index_resource: ["resource", "resource_chunk"],
  write_entity: ["memory_entity"],
  write_entity_branch: ["memory_entity_branch"],
  write_relation: ["memory_relation"],
  tombstone_resource: ["resource"],
  tombstone_entity: ["memory_entity"],
  tombstone_entity_branch: ["memory_entity_branch"],
  tombstone_relation: ["memory_relation"],
  commit: ["memory_entity"],
  merge: ["memory_entity"],
  revert: ["memory_entity"],
  review: ["memory_entity_branch"],
  approve: ["memory_entity_branch"],
  assign_user_role: ["memory_entity"],
  revoke_user_role: ["memory_entity"],
  create_root_entity: ["memory_entity"],
  delete_root_entity: ["memory_entity"],
} as const satisfies Record<
  MemoryAction,
  readonly MemoryObjectKind[]
>;

export function isPermissionCombinationSupported(
  permission: Permission,
): boolean {
  return (
    SUPPORTED_RESOURCE_KINDS_BY_ACTION[
      permission.action
    ] as readonly MemoryObjectKind[]
  ).includes(permission.resourceKind);
}

export function permissionsForActions(
  actions: readonly MemoryAction[],
): Permission[] {
  return actions.flatMap((action) =>
    SUPPORTED_RESOURCE_KINDS_BY_ACTION[action].map((resourceKind) => ({
      action,
      resourceKind,
    })),
  );
}
