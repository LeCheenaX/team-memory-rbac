import type { MemoryRelation } from "../contracts/memory.ts";
import type {
  ResourceCas,
  ResourceCasObject,
  VectorMemoryCollection,
  VectorMemoryFilter,
  VectorMemoryPoint,
  VectorMemoryStore,
  MemoryRelationStore,
} from "./stores.ts";

/** A current-state write set emitted by a History replay consumer. */
export interface MemoryProjectionWrite {
  resource?: ResourceCasObject;
  vectorPoints?: VectorMemoryPoint[];
  removeVectorPoints?: Array<{
    collection: VectorMemoryCollection;
    id: string;
  }>;
  removeVectorPointsByFilter?: Array<{
    collection: VectorMemoryCollection;
    filter: VectorMemoryFilter;
  }>;
  relations?: MemoryRelation[];
  tombstoneRelationIds?: Array<{
    id: string;
    updatedAt: string;
  }>;
}

/**
 * The Memory projection seam deliberately accepts state writes, never commits
 * or operations. History supplies ordering and audit context before this seam.
 */
export interface MemoryProjector {
  project(write: MemoryProjectionWrite): Promise<void>;
}

export class StoreMemoryProjector implements MemoryProjector {
  private readonly resources: ResourceCas;
  private readonly vectors: VectorMemoryStore;
  private readonly relations: MemoryRelationStore;

  constructor(
    resources: ResourceCas,
    vectors: VectorMemoryStore,
    relations: MemoryRelationStore,
  ) {
    this.resources = resources;
    this.vectors = vectors;
    this.relations = relations;
  }

  async project(write: MemoryProjectionWrite): Promise<void> {
    if (write.resource !== undefined) {
      await this.resources.put(write.resource);
    }
    if (write.vectorPoints !== undefined) {
      await this.vectors.upsertMany(write.vectorPoints);
    }
    for (const point of write.removeVectorPoints ?? []) {
      await this.vectors.remove(point);
    }
    for (const removal of write.removeVectorPointsByFilter ?? []) {
      const points = await this.vectors.list({
        collection: removal.collection,
        filter: removal.filter,
        limit: 10_000,
      });
      for (const point of points) {
        await this.vectors.remove({
          collection: removal.collection,
          id: point.id,
        });
      }
    }
    for (const relation of write.relations ?? []) {
      await this.relations.upsert(relation);
    }
    for (const relation of write.tombstoneRelationIds ?? []) {
      await this.relations.tombstone(relation.id, relation.updatedAt);
    }
  }
}
