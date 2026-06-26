import type {
  CloudCommitRecord,
  MemoryConflict,
} from "./authority.ts";

export interface HistoryStore {
  appendCommit(record: CloudCommitRecord): Promise<void>;
  listCommits(options: {
    rootEntityId: string;
    branchRef: string;
    afterSequence?: number;
  }): Promise<CloudCommitRecord[]>;
  saveConflict(conflict: MemoryConflict): Promise<void>;
  listConflicts(options: {
    rootEntityId: string;
    branchRef: string;
  }): Promise<MemoryConflict[]>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** In-memory libSQL-shaped History adapter for authority tests. */
export class InMemoryHistoryStore implements HistoryStore {
  private readonly commits: CloudCommitRecord[] = [];
  private readonly conflicts = new Map<string, MemoryConflict>();

  async appendCommit(record: CloudCommitRecord): Promise<void> {
    if (this.commits.some(({ sequence }) => sequence === record.sequence)) {
      throw new Error(`duplicate history sequence: ${record.sequence}`);
    }
    this.commits.push(clone(record));
  }

  async listCommits(options: {
    rootEntityId: string;
    branchRef: string;
    afterSequence?: number;
  }): Promise<CloudCommitRecord[]> {
    return this.commits
      .filter(
        (record) =>
          record.commit.rootEntityId === options.rootEntityId &&
          record.targetBranchRef === options.branchRef &&
          record.sequence > (options.afterSequence ?? 0),
      )
      .map(clone);
  }

  async saveConflict(conflict: MemoryConflict): Promise<void> {
    this.conflicts.set(conflict.id, clone(conflict));
  }

  async listConflicts(options: {
    rootEntityId: string;
    branchRef: string;
  }): Promise<MemoryConflict[]> {
    return [...this.conflicts.values()]
      .filter(
        (conflict) =>
          conflict.rootEntityId === options.rootEntityId &&
          conflict.targetBranchRef === options.branchRef,
      )
      .map(clone);
  }
}
