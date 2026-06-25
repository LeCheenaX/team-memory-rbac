import type {
  MemoryBranch,
  MemoryCommit,
  MemoryEntity,
  MemoryEntityBranch,
  MemoryRelation,
  Resource,
  ResourceChunk,
  ResourceRevision,
  MemoryOperationKind,
} from "../contracts/memory.ts";
import type { PermissionRequest } from "../contracts/rbac.ts";

export type CreateEntityOperation = {
  kind: "create_entity";
  id: string;
  entity: MemoryEntity;
};

export type CreateEntityBranchOperation = {
  kind: "create_entity_branch";
  id: string;
  branch: Omit<MemoryEntityBranch, "commitId">;
};

export type CreateRelationOperation = {
  kind: "create_relation";
  id: string;
  relation: Omit<MemoryRelation, "commitId">;
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
  replacement: Omit<MemoryRelation, "commitId">;
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

export type MemoryOperationInput =
  | CreateEntityOperation
  | CreateEntityBranchOperation
  | CreateRelationOperation
  | CreateResourceOperation
  | CreateResourceChunkOperation
  | ReviseResourceOperation
  | ReplaceRelationOperation
  | TombstoneOperation
  | RevertCommitOperation;

export interface MemoryOperation {
  id: string;
  rootEntityId: string;
  branchRef: string;
  commitId: string;
  kind: MemoryOperationKind;
  actor: {
    kind: "user" | "agent";
    id: string;
  };
  input: MemoryOperationInput;
  createdAt: string;
}

export interface MemoryWriteCommand extends PermissionRequest {
  branchRef: string;
  commit: {
    id: string;
    message?: string;
  };
  operation: MemoryOperationInput;
}

export interface MemoryWriteResult {
  commit: MemoryCommit;
  operations: MemoryOperation[];
}

export interface MemoryActiveView {
  rootEntityId: string;
  branchRef: string;
  entities: MemoryEntity[];
  entityBranches: MemoryEntityBranch[];
  relations: MemoryRelation[];
  resources: Resource[];
  resourceChunks: ResourceChunk[];
}

export interface MemoryAuthoritySeed {
  entities?: MemoryEntity[];
  entityBranches?: MemoryEntityBranch[];
  relations?: MemoryRelation[];
  resources?: Resource[];
  resourceChunks?: ResourceChunk[];
  resourceRevisions?: ResourceRevision[];
  branches?: MemoryBranch[];
}
