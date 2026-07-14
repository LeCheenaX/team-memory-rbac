import {
  MEMORY_ACTIONS,
  type Role,
} from "../contracts/rbac.ts";
import { permissionsForActions } from "./permissions.ts";

const readPermissions = permissionsForActions([
  "read",
  "search",
  "traverse_relation",
]);

export const BUILT_IN_ROLES: readonly Role[] = [
  {
    id: "role-researcher",
    name: "researcher",
    kind: "built_in",
    status: "active",
    permissions: readPermissions,
  },
  {
    id: "role-curator",
    name: "curator",
    kind: "built_in",
    status: "active",
    permissions: [
      ...readPermissions,
      ...permissionsForActions([
        "write_entity",
        "write_entity_branch",
        "write_relation",
        "tombstone_entity",
        "tombstone_entity_branch",
        "tombstone_relation",
        "commit",
        "review",
      ]),
    ],
  },
  {
    id: "role-resource-importer",
    name: "resource_importer",
    kind: "built_in",
    status: "active",
    permissions: [
      ...permissionsForActions(["import_resource", "index_resource"]),
      ...(["resource", "resource_chunk"] as const).flatMap(
        (resourceKind) =>
          (["read", "search"] as const).map((action) => ({
            action,
            resourceKind,
          })),
      ),
      {
        action: "write_resource_chunk",
        resourceKind: "resource_chunk",
      },
    ],
  },
  {
    id: "role-maintainer",
    name: "maintainer",
    kind: "built_in",
    status: "active",
    permissions: permissionsForActions(
      MEMORY_ACTIONS.filter(
        (action) =>
          ![
            "assign_user_role",
            "revoke_user_role",
            "create_root_entity",
            "delete_root_entity",
          ].includes(action),
      ),
    ),
  },
  {
    id: "role-root-admin",
    name: "root_admin",
    kind: "built_in",
    status: "active",
    permissions: permissionsForActions(MEMORY_ACTIONS),
  },
] as const;

export function getBuiltInRole(roleId: string): Role | undefined {
  return BUILT_IN_ROLES.find((role) => role.id === roleId);
}
