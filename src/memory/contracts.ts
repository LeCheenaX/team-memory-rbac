import type {
  MemoryEntity,
  MemoryEntityBranch,
  MemoryRelation,
  Resource,
  ResourceChunk,
} from "../contracts/memory.ts";
import type {
  MemoryBranch,
  ResourceRevision,
} from "../contracts/history.ts";

/** Current Memory state only; commits and operations are projected by History. */
export interface MemoryActiveView {
  rootEntityId: string;
  branchRef: string;
  entities: MemoryEntity[];
  entityBranches: MemoryEntityBranch[];
  relations: MemoryRelation[];
  resources: Resource[];
  resourceChunks: ResourceChunk[];
}

/** @deprecated Combined reference seed retained until the legacy authority is removed. */
export interface MemoryAuthoritySeed {
  entities?: MemoryEntity[];
  entityBranches?: MemoryEntityBranch[];
  relations?: MemoryRelation[];
  resources?: Resource[];
  resourceChunks?: ResourceChunk[];
  resourceRevisions?: ResourceRevision[];
  branches?: MemoryBranch[];
}
