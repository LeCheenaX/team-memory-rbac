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
  memoryId?: string;
  collection?: VectorMemoryCollection;
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
  score?: number;
}

export interface VectorMemoryFilter {
  rootEntityId: string | null;
  branchRef?: string;
  resourceId?: string | string[];
  entityId?: string | string[];
  status?: string | string[];
  tagsAny?: string[];
  tagsNone?: string[];
}

export interface VectorMemoryStore {
  upsert(point: VectorMemoryPoint): Promise<void>;
  upsertMany(points: VectorMemoryPoint[]): Promise<void>;
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
  list(options: {
    collection: VectorMemoryCollection;
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
    relationTypes?: MemoryRelation["relationType"][];
    status?: MemoryRelation["status"];
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
  payload.memoryId ??= point.id;
  payload.collection ??= point.collection;
  payload.status ??= "active";
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

function payloadMatches(
  payload: MemoryVectorPayload,
  filter: VectorMemoryFilter,
): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (key === "tagsAny") {
      const tags = Array.isArray(payload.tags) ? payload.tags : [];
      if (
        value !== undefined &&
        !(value as string[]).some((tag) => tags.includes(tag))
      ) {
        return false;
      }
      continue;
    }
    if (key === "tagsNone") {
      const tags = Array.isArray(payload.tags) ? payload.tags : [];
      if (
        value !== undefined &&
        (value as string[]).some((tag) => tags.includes(tag))
      ) {
        return false;
      }
      continue;
    }
    const actual = payload[key];
    if (Array.isArray(value)) {
      if (!value.includes(actual as never)) {
        return false;
      }
    } else if (actual !== value) {
      return false;
    }
  }
  return true;
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

  async upsertMany(points: VectorMemoryPoint[]): Promise<void> {
    const normalized = points.map((point) => ({
      ...clone(point),
      payload: normalizedPayload(point),
    }));
    for (const point of normalized) {
      this.points.set(`${point.collection}:${point.id}`, point);
    }
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
      .filter((point) => payloadMatches(point.payload, options.filter))
      .sort(
        (left, right) =>
          score(right.vector, options.vector) -
          score(left.vector, options.vector),
      )
      .slice(0, options.limit ?? 20)
      .map((point) => ({
        ...clone(point),
        score: score(point.vector, options.vector),
      }));
  }

  async list(options: {
    collection: VectorMemoryCollection;
    filter: VectorMemoryFilter;
    limit?: number;
  }): Promise<VectorMemoryPoint[]> {
    return [...this.points.values()]
      .filter((point) => point.collection === options.collection)
      .filter((point) => payloadMatches(point.payload, options.filter))
      .slice(0, options.limit ?? 100)
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
    relationTypes?: MemoryRelation["relationType"][];
    status?: MemoryRelation["status"];
  }): Promise<MemoryRelation[]> {
    return [...this.relations.values()]
      .filter(
        (relation) =>
          relation.rootEntityId === options.rootEntityId &&
          relation.branchRef === options.branchRef &&
          (options.sourceId === undefined ||
            relation.sourceId === options.sourceId) &&
          (options.relationTypes === undefined ||
            options.relationTypes.includes(relation.relationType)) &&
          (options.status === undefined ||
            relation.status === options.status),
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
