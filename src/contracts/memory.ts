export const MEMORY_RELATION_TYPES = [
  "has",
  "depends_on",
  "relates_to",
  "refers_to",
  "contradicts",
  "supersedes",
  "next_is",
] as const;

export type MemoryRelationType = (typeof MEMORY_RELATION_TYPES)[number];

export const MEMORY_OBJECT_KINDS = [
  "memory_entity",
  "memory_entity_branch",
  "memory_relation",
  "resource",
  "resource_chunk",
] as const;

export type MemoryObjectKind = (typeof MEMORY_OBJECT_KINDS)[number];

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

export type MemoryEntityStatus =
  | "active"
  | "archived"
  | "tombstoned"
  | "conflicted";

export type MemoryRelationStatus = "active" | "tombstoned" | "conflicted";
export type MemoryBranchStatus = "active" | "archived";
export type MemoryRecordStatus = "active" | "tombstoned";

export interface MemoryActor {
  kind: "user" | "agent";
  id: string;
}

export interface MemoryEntity {
  id: string;
  rootEntityId: string | null;
  status: MemoryEntityStatus;
  currentBranchId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryEntityBranch {
  id: string;
  entityId: string;
  rootEntityId: string;
  branchRef: string;
  commitId: string;
  parentBranchId?: string;
  title: string;
  description: string;
  tags: string[];
  extraInfo?: Record<string, unknown>;
  embedding?: number[];
  importance: number;
  confidence: number;
  status?: MemoryRelationStatus;
  createdAt: string;
  updatedAt: string;
}

export type RelationEndpointKind =
  | "memory_entity"
  | "resource"
  | "resource_chunk";

export interface MemoryRelation {
  id: string;
  rootEntityId: string;
  sourceId: string;
  sourceKind: RelationEndpointKind;
  targetId: string;
  targetKind: RelationEndpointKind;
  relationType: MemoryRelationType;
  role?: string;
  ordinal?: number;
  required?: boolean;
  condition?: Record<string, unknown>;
  weight: number;
  confidence: number;
  branchRef: string;
  commitId: string;
  status: MemoryRelationStatus;
  createdAt: string;
  updatedAt: string;
}

export type ResourceSourceType =
  | "document"
  | "conversation"
  | "code_repo"
  | "code_file"
  | "tool_output"
  | "webpage"
  | "ticket"
  | "database_record";

export interface Resource {
  id: string;
  rootEntityId: string;
  sourceType: ResourceSourceType;
  title: string;
  uri?: string;
  contentHash: string;
  currentRevisionId?: string;
  status?: MemoryRecordStatus;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceChunk {
  id: string;
  rootEntityId: string;
  resourceId: string;
  chunkIndex: number;
  text: string;
  embedding?: number[];
  bm25DocumentId?: string;
  status?: MemoryRecordStatus;
  metadata?: {
    headingPath?: string[];
    filePath?: string;
    startLine?: number;
    endLine?: number;
    tokenCount?: number;
  };
  createdAt: string;
  updatedAt: string;
}

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

export interface MemoryObjectIdentity {
  kind: MemoryObjectKind;
  id: string;
  rootEntityId: string | null;
}

export interface MemoryModelCollection {
  entities?: MemoryEntity[];
  entityBranches?: MemoryEntityBranch[];
  relations?: MemoryRelation[];
  resources?: Resource[];
  resourceChunks?: ResourceChunk[];
  resourceRevisions?: ResourceRevision[];
  branches?: MemoryBranch[];
  commits?: MemoryCommit[];
  snapshots?: MemorySnapshot[];
}

export const RELATIONSHIP_EXTRA_INFO_KEYS = [
  "contradicts",
  "dependsOn",
  "depends_on",
  "nextIs",
  "next_is",
  "references",
  "relations",
  "steps",
  "supersedes",
] as const;

const relationshipExtraInfoKeySet = new Set<string>(
  RELATIONSHIP_EXTRA_INFO_KEYS,
);

export function isMemoryRelationType(
  value: unknown,
): value is MemoryRelationType {
  return (
    typeof value === "string" &&
    (MEMORY_RELATION_TYPES as readonly string[]).includes(value)
  );
}

export function assertMemoryObjectInvariants(
  object: MemoryObjectIdentity,
): void {
  if (object.kind === "memory_entity" && object.rootEntityId === null) {
    return;
  }

  if (
    typeof object.rootEntityId !== "string" ||
    object.rootEntityId.length === 0
  ) {
    throw new Error(
      `${object.kind}.rootEntityId must be a non-empty string`,
    );
  }
}

export function effectiveRootEntityId(entity: MemoryEntity): string {
  return entity.rootEntityId ?? entity.id;
}

function assertNonEmptyRoot(
  kind: string,
  rootEntityId: string,
): void {
  if (rootEntityId.length === 0) {
    throw new Error(`${kind}.rootEntityId must be a non-empty string`);
  }
}

export function assertMemoryModelInvariants(
  collection: MemoryModelCollection,
): void {
  for (const entity of collection.entities ?? []) {
    assertMemoryObjectInvariants({
      kind: "memory_entity",
      id: entity.id,
      rootEntityId: entity.rootEntityId,
    });
  }
  for (const branch of collection.entityBranches ?? []) {
    assertMemoryObjectInvariants({
      kind: "memory_entity_branch",
      id: branch.id,
      rootEntityId: branch.rootEntityId,
    });
    if (branch.extraInfo !== undefined) {
      assertEntityExtraInfo(branch.extraInfo);
    }
  }
  for (const relation of collection.relations ?? []) {
    assertMemoryObjectInvariants({
      kind: "memory_relation",
      id: relation.id,
      rootEntityId: relation.rootEntityId,
    });
    if (!isMemoryRelationType(relation.relationType)) {
      throw new Error(
        `unsupported MemoryRelationType: ${relation.relationType}`,
      );
    }
  }
  for (const resource of collection.resources ?? []) {
    assertMemoryObjectInvariants({
      kind: "resource",
      id: resource.id,
      rootEntityId: resource.rootEntityId,
    });
  }
  for (const chunk of collection.resourceChunks ?? []) {
    assertMemoryObjectInvariants({
      kind: "resource_chunk",
      id: chunk.id,
      rootEntityId: chunk.rootEntityId,
    });
  }
  for (const revision of collection.resourceRevisions ?? []) {
    assertNonEmptyRoot("ResourceRevision", revision.rootEntityId);
  }
  for (const branch of collection.branches ?? []) {
    assertNonEmptyRoot("MemoryBranch", branch.rootEntityId);
  }
  for (const commit of collection.commits ?? []) {
    assertNonEmptyRoot("MemoryCommit", commit.rootEntityId);
  }
  for (const snapshot of collection.snapshots ?? []) {
    assertNonEmptyRoot("MemorySnapshot", snapshot.rootEntityId);
  }
}

export function assertEntityExtraInfo(
  extraInfo: Record<string, unknown>,
): void {
  for (const key of Object.keys(extraInfo)) {
    if (relationshipExtraInfoKeySet.has(key)) {
      throw new Error(
        `extraInfo.${key} describes a relationship; use MemoryRelation instead`,
      );
    }
  }
}
