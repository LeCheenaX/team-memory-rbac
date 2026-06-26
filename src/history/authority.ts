import {
  InMemoryCloudMemoryAuthority,
  conflictKeysForOperation,
  type CloudCommitRecord,
  type CloudMemoryWriteCommand,
  type CloudMemoryWriteResult,
  type ConflictResolutionCommand,
  type ConflictResolutionResult,
  type MemoryConflict,
} from "./cloud-authority.ts";
import type { AuthorizedMemoryRequest } from "../permission-router.ts";

export { InMemoryCloudMemoryAuthority };
export { conflictKeysForOperation };

export type {
  CloudCommitRecord,
  CloudMemoryWriteCommand,
  CloudMemoryWriteResult,
  ConflictResolutionCommand,
  ConflictResolutionResult,
  MemoryConflict,
};

export interface HistoryReplayRequest {
  rootEntityId: string;
  branchRef: string;
  afterSequence?: number;
}

export interface HistoryProjectionEvent {
  sequence: number;
  commit: CloudCommitRecord["commit"];
  operations: CloudCommitRecord["operations"];
}

/**
 * The History seam owns commits, branch heads, conflict detection and replay.
 * It deliberately returns projection events instead of a Memory active view.
 */
export interface HistoryAuthority {
  execute(
    request: AuthorizedMemoryRequest<CloudMemoryWriteCommand>,
  ): Promise<CloudMemoryWriteResult>;
  listCommitRecords(
    rootEntityId: string,
    branchRef: string,
    afterSequence?: number,
  ): CloudCommitRecord[];
  listConflicts(rootEntityId: string, branchRef: string): MemoryConflict[];
  commitWatermark(): number;
  headCommitId(rootEntityId: string, branchRef: string): string | undefined;
  resolveConflict(
    request: AuthorizedMemoryRequest<ConflictResolutionCommand>,
  ): Promise<ConflictResolutionResult>;
  replay(request: HistoryReplayRequest): Promise<HistoryProjectionEvent[]>;
}

/**
 * In-memory History adapter. The combined implementation remains underneath
 * temporarily for backwards-compatible fixtures while Memory projection is
 * split out in subsequent adapters.
 */
export class InMemoryHistoryAuthority
  extends InMemoryCloudMemoryAuthority
  implements HistoryAuthority
{
  async replay(
    request: HistoryReplayRequest,
  ): Promise<HistoryProjectionEvent[]> {
    return this.listCommitRecords(
      request.rootEntityId,
      request.branchRef,
      request.afterSequence,
    )
      .filter((record) => record.status === "accepted")
      .map((record) => ({
        sequence: record.sequence,
        commit: record.commit,
        operations: record.operations,
      }));
  }
}
