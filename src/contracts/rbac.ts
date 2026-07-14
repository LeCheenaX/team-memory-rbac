import type {
  MemoryObjectKind,
  MemoryRelationType,
} from "./memory.ts";

export const MEMORY_ACTIONS = [
  "read",
  "search",
  "traverse_relation",
  "import_resource",
  "write_resource_chunk",
  "index_resource",
  "write_entity",
  "write_entity_branch",
  "write_relation",
  "tombstone_resource",
  "tombstone_entity",
  "tombstone_entity_branch",
  "tombstone_relation",
  "commit",
  "merge",
  "revert",
  "review",
  "approve",
  "assign_user_role",
  "revoke_user_role",
  "create_root_entity",
  "delete_root_entity",
] as const;

export type MemoryAction = (typeof MEMORY_ACTIONS)[number];

export const ADMIN_MEMORY_ACTIONS = [
  "assign_user_role",
  "revoke_user_role",
  "create_root_entity",
  "delete_root_entity",
] as const satisfies readonly MemoryAction[];

export type AdminMemoryAction = (typeof ADMIN_MEMORY_ACTIONS)[number];

export function isAdminMemoryAction(
  action: MemoryAction,
): action is AdminMemoryAction {
  return (ADMIN_MEMORY_ACTIONS as readonly MemoryAction[]).includes(action);
}

export interface User {
  id: string;
  displayName: string;
  email?: string;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export const AGENT_TYPES = [
  "main_agent",
  "sub_agent",
  "tool_agent",
  "import_agent",
  "curator_agent",
  "review_agent",
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

export interface AgentIdentity {
  id: string;
  ownerUserId: string;
  agentType: AgentType;
  displayName: string;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export interface PermissionConstraint {
  allowedTags?: string[];
  requiredTags?: string[];
  deniedTags?: string[];
  allowedRelationTypes?: MemoryRelationType[];
  deniedRelationTypes?: MemoryRelationType[];
  allowRootEntityMutation?: boolean;
  maxRelationExpansionDepth?: number;
  requireHumanApproval?: boolean;
}

export interface Permission {
  action: MemoryAction;
  resourceKind: MemoryObjectKind;
  tagsAny?: string[];
  tagsAll?: string[];
  relationTypes?: MemoryRelationType[];
  taskScope?: string[];
}

export interface Role {
  id: string;
  name: string;
  kind: "built_in" | "custom";
  permissions: Permission[];
  status: "active" | "disabled";
}

export interface UserRootRoleAssignment {
  id: string;
  userId: string;
  rootEntityId: string;
  roleId: string;
  assignedBy: string;
  assignedAt: string;
  status: "active" | "revoked";
  revokedAt?: string;
  expiresAt?: string;
}

export interface TaskScope {
  rootEntityId: string;
  allowedEntityIds?: string[];
  deniedEntityIds?: string[];
  allowedTags?: string[];
  deniedTags?: string[];
  allowedResourceIds?: string[];
  deniedResourceIds?: string[];
  relationExpansionPolicy?: {
    allowedRelationTypes?: MemoryRelationType[];
    maxDepth?: number;
    allowRequiredDependencies?: boolean;
  };
}

export interface AgentDelegation {
  id: string;
  agentId?: string;
  ownerUserId: string;
  rootEntityId: string;
  permissions: Permission[];
  delegatedBy: string;
  delegatedAt: string;
  status: "active" | "revoked";
  revokedAt?: string;
  expiresAt?: string;
}

export interface PrincipalContext {
  sessionId: string;
  userId: string;
  agentId: string;
  rootEntityId: string;
  taskScope: TaskScope;
  delegationId?: string;
  parentAgentId?: string;
}

export type PermissionSubject =
  | {
      kind: "user";
      userId: string;
    }
  | {
      kind: "agent";
      agentId: string;
      ownerUserId: string;
    };

export interface PermissionRequest {
  subject: PermissionSubject;
  rootEntityId: string;
  action: MemoryAction;
  resourceKind: MemoryObjectKind;
  branchRef?: string;
  entityId?: string;
  resourceId?: string;
  tags?: string[];
  relationType?: MemoryRelationType;
  relationDepth?: number;
  taskScope?: TaskScope;
}

export interface PermissionDecision {
  allowed: boolean;
  reason: string;
  subjectId: string;
  subjectKind: PermissionSubject["kind"];
  rootEntityId: string;
  action: MemoryAction;
  resourceKind: MemoryObjectKind;
  matchedRoles: string[];
  missingActions: MemoryAction[];
  constraints: PermissionConstraint;
}

export interface PolicyEngine {
  decide(request: PermissionRequest): Promise<PermissionDecision>;
}

export interface RbacAuthority {
  getUser(userId: string): Promise<User | undefined>;
  getAgent(agentId: string): Promise<AgentIdentity | undefined>;
  getRole(roleId: string): Promise<Role | undefined>;
  listUserRootRoleAssignments(
    userId: string,
    rootEntityId: string,
  ): Promise<UserRootRoleAssignment[]>;
  listAgentDelegations(
    agentId: string,
    rootEntityId: string,
  ): Promise<AgentDelegation[]>;
}

export interface PermissionDecisionCache {
  get(request: PermissionRequest): Promise<PermissionDecision | undefined>;
  set(
    request: PermissionRequest,
    decision: PermissionDecision,
  ): Promise<void>;
  invalidateSubjectAtRoot(
    subjectId: string,
    rootEntityId: string,
  ): Promise<void>;
}

export interface PermissionAuditLog {
  record(
    request: PermissionRequest,
    decision: PermissionDecision,
  ): Promise<void>;
}
