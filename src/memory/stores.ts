import type {
  MemoryEntity,
  MemoryEntityBranch,
  MemoryRelation,
  ResourceChunk,
} from "../contracts/memory.ts";

export const VECTOR_MEMORY_COLLECTIONS = [
  "resource_chunks",
  "memory_entity_branches",
  "memory_entities",
] as const;

export type VectorMemoryCollection =
  (typeof VECTOR_MEMORY_COLLECTIONS)[number];

/** The portable subset of a Qdrant payload used by Memory adapters. */
export interface MemoryVectorPayload extends Record<string, unknown> {
  rootEntityId: string | null;
  branchRef?: string;
  resourceId?: string;
  chunkId?: string;
  entityId?: string;
  entityBranchId?: string;
  origin?: "cloud_snapshot" | "local_pending" | "resolution" | "import";
  pendingId?: string | null;
  status?: string;
}

export interface VectorMemoryPoint {
  collection: VectorMemoryCollection;
  id: string;
  vector: number[];
  payload: MemoryVectorPayload;
}

export interface VectorMemoryFilter {
  rootEntityId: string | null;
  branchRef?: string;
  resourceId?: string;
  entityId?: string;
  status?: string;
}

export interface VectorMemoryStore {
  upsert(point: VectorMemoryPoint): Promise<void>;
  get(
    collection: VectorMemoryCollection,
    id: string,
  ): Promise<VectorMemoryPoint | undefined>;
  search(options: {
    collection: VectorMemoryCollection;
    vector: number[];
    filter: VectorMemoryFilter;
    limit?: number;
  }): Promise<VectorMemoryPoint[]>;
  remove(options: {
    collection: VectorMemoryCollection;
    id: string;
  }): Promise<void>;
}

export interface ResourceCasObject {
  contentHash: string;
  content: string | Uint8Array;
}

export interface ResourceCas {
  put(object: ResourceCasObject): Promise<void>;
  get(contentHash: string): Promise<ResourceCasObject | undefined>;
  remove(contentHash: string): Promise<void>;
}

export interface MemoryRelationStore {
  upsert(relation: MemoryRelation): Promise<void>;
  get(id: string): Promise<MemoryRelation | undefined>;
  list(options: {
    rootEntityId: string;
    branchRef: string;
    sourceId?: string;
  }): Promise<MemoryRelation[]>;
  tombstone(id: string, updatedAt: string): Promise<void>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function score(vector: number[], query: number[]): number {
  return vector.reduce(
    (total, item, index) => total + item * (query[index] ?? 0),
    0,
  );
}

function normalizedPayload(point: VectorMemoryPoint): MemoryVectorPayload {
  const payload = clone(point.payload);
  if (point.collection === "resource_chunks") {
    payload.chunkId ??= point.id;
  }
  if (point.collection === "memory_entity_branches") {
    payload.entityBranchId ??= point.id;
  }
  if (point.collection === "memory_entities") {
    payload.entityId ??= point.id;
  }
  return payload;
}

/** In-memory Qdrant-shaped adapter for tests and local composition. */
export class InMemoryVectorMemoryStore implements VectorMemoryStore {
  private readonly points = new Map<string, VectorMemoryPoint>();

  async upsert(point: VectorMemoryPoint): Promise<void> {
    this.points.set(`${point.collection}:${point.id}`, {
      ...clone(point),
      payload: normalizedPayload(point),
    });
  }

  async get(
    collection: VectorMemoryCollection,
    id: string,
  ): Promise<VectorMemoryPoint | undefined> {
    const point = this.points.get(`${collection}:${id}`);
    return point === undefined ? undefined : clone(point);
  }

  async search(options: {
    collection: VectorMemoryCollection;
    vector: number[];
    filter: VectorMemoryFilter;
    limit?: number;
  }): Promise<VectorMemoryPoint[]> {
    return [...this.points.values()]
      .filter((point) => point.collection === options.collection)
      .filter((point) =>
        Object.entries(options.filter).every(
          ([key, value]) => point.payload[key] === value,
        ),
      )
      .sort(
        (left, right) =>
          score(right.vector, options.vector) -
          score(left.vector, options.vector),
      )
      .slice(0, options.limit ?? 20)
      .map(clone);
  }

  async remove(options: {
    collection: VectorMemoryCollection;
    id: string;
  }): Promise<void> {
    this.points.delete(`${options.collection}:${options.id}`);
  }
}

export class InMemoryResourceCas implements ResourceCas {
  private readonly objects = new Map<string, ResourceCasObject>();

  async put(object: ResourceCasObject): Promise<void> {
    this.objects.set(object.contentHash, clone(object));
  }

  async get(contentHash: string): Promise<ResourceCasObject | undefined> {
    const object = this.objects.get(contentHash);
    return object === undefined ? undefined : clone(object);
  }

  async remove(contentHash: string): Promise<void> {
    this.objects.delete(contentHash);
  }
}

/** In-memory libSQL-shaped relation adapter for tests and local composition. */
export class InMemoryMemoryRelationStore implements MemoryRelationStore {
  private readonly relations = new Map<string, MemoryRelation>();

  async upsert(relation: MemoryRelation): Promise<void> {
    this.relations.set(relation.id, clone(relation));
  }

  async get(id: string): Promise<MemoryRelation | undefined> {
    const relation = this.relations.get(id);
    return relation === undefined ? undefined : clone(relation);
  }

  async list(options: {
    rootEntityId: string;
    branchRef: string;
    sourceId?: string;
  }): Promise<MemoryRelation[]> {
    return [...this.relations.values()]
      .filter(
        (relation) =>
          relation.rootEntityId === options.rootEntityId &&
          relation.branchRef === options.branchRef &&
          (options.sourceId === undefined ||
            relation.sourceId === options.sourceId),
      )
      .map(clone);
  }

  async tombstone(id: string, updatedAt: string): Promise<void> {
    const relation = this.relations.get(id);
    if (relation !== undefined) {
      relation.status = "tombstoned";
      relation.updatedAt = updatedAt;
    }
  }
}

export type VectorMemoryPayloadSource =
  | MemoryEntity
  | MemoryEntityBranch
  | ResourceChunk;
