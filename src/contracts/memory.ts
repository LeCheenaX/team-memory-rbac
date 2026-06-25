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

export type MemoryEntityStatus =
  | "active"
  | "archived"
  | "tombstoned"
  | "conflicted";

export type MemoryRelationStatus = "active" | "tombstoned" | "conflicted";

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

export interface MemoryObjectIdentity {
  kind: MemoryObjectKind;
  id: string;
  rootEntityId: string | null;
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
