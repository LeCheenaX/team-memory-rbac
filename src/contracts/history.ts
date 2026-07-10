import type {
  MemoryEntity,
  MemoryEntityBranch,
  MemoryObjectKind,
  MemoryRelation,
  Resource,
  ResourceChunk,
} from "./memory.ts";
import type { PermissionRequest } from "./rbac.ts";

export const MEMORY_OPERATION_KINDS = [
  "create_entity",
  "create_entity_branch",
  "create_relation",
  "create_resource",
  "create_resource_chunk",
  "revise_resource",
  "replace_relation",
  "tombstone_resource",
  "tombstone_entity",
  "tombstone_entity_branch",
  "tombstone_relation",
  "revert_commit",
  "resolve_conflict",
] as const;

export type MemoryOperationKind =
  (typeof MEMORY_OPERATION_KINDS)[number];

export type MemoryBranchStatus = "active" | "archived";

export interface MemoryActor {
  kind: "user" | "agent";
  id: string;
}

/** Resource revisions are append-only History records, not Memory state. */
export interface ResourceRevision {
  id: string;
  resourceId: string;
  rootEntityId: string;
  commitId: string;
  parentRevisionId?: string;
  contentHash: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface MemoryBranch {
  id: string;
  rootEntityId: string;
  branchRef: string;
  headCommitId?: string;
  status: MemoryBranchStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryCommit {
  id: string;
  rootEntityId: string;
  branchRef: string;
  parentCommitId?: string;
  operationIds: string[];
  actor: MemoryActor;
  message?: string;
  createdAt: string;
}

export interface MemorySnapshot {
  id: string;
  rootEntityId: string;
  branchRef: string;
  commitId: string;
  createdAt: string;
}

export type CreateEntityOperation = {
  kind: "create_entity";
  id: string;
  entity: MemoryEntity;
};

export type CreateEntityBranchOperation = {
  kind: "create_entity_branch";
  id: string;
  branch: MemoryEntityBranch;
};

export type CreateRelationOperation = {
  kind: "create_relation";
  id: string;
  relation: MemoryRelation;
};

export type CreateResourceOperation = {
  kind: "create_resource";
  id: string;
  resource: Resource;
  revisionId: string;
};

export type CreateResourceChunkOperation = {
  kind: "create_resource_chunk";
  id: string;
  chunk: ResourceChunk;
};

export type ReviseResourceOperation = {
  kind: "revise_resource";
  id: string;
  resourceId: string;
  revisionId: string;
  contentHash: string;
  metadata?: Record<string, unknown>;
};

export type ReplaceRelationOperation = {
  kind: "replace_relation";
  id: string;
  previousRelationId: string;
  replacementOperationId: string;
  replacement: MemoryRelation;
};

export type TombstoneOperation = {
  kind:
    | "tombstone_resource"
    | "tombstone_entity"
    | "tombstone_entity_branch"
    | "tombstone_relation";
  id: string;
  targetId: string;
};

export type RevertCommitOperation = {
  kind: "revert_commit";
  id: string;
  targetCommitId: string;
};

export type ConflictResolutionKind =
  | "keep_target"
  | "take_incoming"
  | "manual_merge";

export type ResolveConflictOperation = {
  kind: "resolve_conflict";
  id: string;
  resolvedConflictIds: string[];
  resolvedIncomingCommitIds: string[];
  resolutionKind: ConflictResolutionKind;
};

export type MemoryOperationInput =
  | CreateEntityOperation
  | CreateEntityBranchOperation
  | CreateRelationOperation
  | CreateResourceOperation
  | CreateResourceChunkOperation
  | ReviseResourceOperation
  | ReplaceRelationOperation
  | TombstoneOperation
  | RevertCommitOperation
  | ResolveConflictOperation;

export interface MemoryOperation {
  id: string;
  rootEntityId: string;
  branchRef: string;
  commitId: string;
  kind: MemoryOperationKind;
  actor: MemoryActor;
  provenance?: {
    sessionId?: string;
    ownerUserId?: string;
    delegationId?: string;
    parentAgentId?: string;
  };
  input: MemoryOperationInput;
  createdAt: string;
}

export interface HistoryWriteCommand extends PermissionRequest {
  branchRef: string;
  commit: {
    id: string;
    message?: string;
  };
  operation: MemoryOperationInput;
  operations?: MemoryOperationInput[];
  provenance?: MemoryOperation["provenance"];
}

export interface HistoryWriteResult {
  commit: MemoryCommit;
  operations: MemoryOperation[];
}

export interface HistoryModelCollection {
  resourceRevisions?: ResourceRevision[];
  branches?: MemoryBranch[];
  commits?: MemoryCommit[];
  snapshots?: MemorySnapshot[];
}

export function assertHistoryModelInvariants(
  collection: HistoryModelCollection,
): void {
  for (const [kind, records] of [
    ["ResourceRevision", collection.resourceRevisions],
    ["MemoryBranch", collection.branches],
    ["MemoryCommit", collection.commits],
    ["MemorySnapshot", collection.snapshots],
  ] as const) {
    for (const record of records ?? []) {
      if (record.rootEntityId.length === 0) {
        throw new Error(`${kind}.rootEntityId must be a non-empty string`);
      }
    }
  }
}

export type HistoryObjectKind = Extract<
  MemoryObjectKind,
  "memory_entity" | "memory_entity_branch" | "memory_relation" | "resource" | "resource_chunk"
>;
