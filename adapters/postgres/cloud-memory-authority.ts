import type {
  AuthorizedMemoryRequest,
} from "../../src/permission-router.ts";
import {
  InMemoryCloudMemoryAuthority,
  type CloudCommitRecord,
  type CloudMemoryAuthority,
  type CloudMemoryWriteCommand,
  type CloudMemoryWriteResult,
} from "../../src/memory/cloud-authority.ts";
import type {
  MemoryActiveView,
  MemoryAuthoritySeed,
} from "../../src/memory/contracts.ts";

export interface PostgresQueryResult<Row> {
  rows: Row[];
}

export interface PostgresTransaction {
  query<Row = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<PostgresQueryResult<Row>>;
}

export interface PostgresPool {
  transaction<T>(
    callback: (transaction: PostgresTransaction) => Promise<T>,
  ): Promise<T>;
}

interface PersistedAuthorityState {
  seed: MemoryAuthoritySeed;
  requests: AuthorizedMemoryRequest<CloudMemoryWriteCommand>[];
}

interface StateRow {
  payload: PersistedAuthorityState;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function restore(
  state: PersistedAuthorityState,
): Promise<InMemoryCloudMemoryAuthority> {
  const authority = new InMemoryCloudMemoryAuthority(clone(state.seed));
  for (const request of state.requests) {
    await authority.execute(clone(request));
  }
  return authority;
}

export class PostgresCloudMemoryAuthority
  implements CloudMemoryAuthority
{
  private delegate: InMemoryCloudMemoryAuthority;
  private readonly pool: PostgresPool;
  private readonly authorityKey: string;
  private readonly initialSeed: MemoryAuthoritySeed;

  private constructor(
    pool: PostgresPool,
    authorityKey: string,
    initialSeed: MemoryAuthoritySeed,
    delegate: InMemoryCloudMemoryAuthority,
  ) {
    this.pool = pool;
    this.authorityKey = authorityKey;
    this.initialSeed = initialSeed;
    this.delegate = delegate;
  }

  static async open(
    pool: PostgresPool,
    authorityKey: string,
    seed: MemoryAuthoritySeed = {},
  ): Promise<PostgresCloudMemoryAuthority> {
    const state = await pool.transaction(async (transaction) => {
      await PostgresCloudMemoryAuthority.ensureState(
        transaction,
        authorityKey,
        seed,
      );
      return PostgresCloudMemoryAuthority.loadState(
        transaction,
        authorityKey,
        seed,
        false,
      );
    });
    return new PostgresCloudMemoryAuthority(
      pool,
      authorityKey,
      clone(seed),
      await restore(state),
    );
  }

  async execute(
    request: AuthorizedMemoryRequest<CloudMemoryWriteCommand>,
  ): Promise<CloudMemoryWriteResult> {
    const committed = await this.pool.transaction(async (transaction) => {
      const state = await PostgresCloudMemoryAuthority.loadState(
        transaction,
        this.authorityKey,
        this.initialSeed,
        true,
      );
      const authority = await restore(state);
      const before = authority.commitWatermark();
      const alreadyRecorded = state.requests.some(
        (candidate) =>
          candidate.rootEntityId === request.rootEntityId &&
          candidate.branchRef === request.branchRef &&
          candidate.clientMutationId === request.clientMutationId,
      );
      const result = await authority.execute(clone(request));
      if (!alreadyRecorded) {
        state.requests.push(clone(request));
      }

      await transaction.query(
        `INSERT INTO team_memory_authority_state
           (authority_key, payload, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (authority_key) DO UPDATE
           SET payload = EXCLUDED.payload, updated_at = now()`,
        [this.authorityKey, JSON.stringify(state)],
      );
      const records = authority.listCommitRecords(
        request.rootEntityId,
        request.branchRef,
        before,
      );
      await this.persistRecords(transaction, records);
      await this.persistConflicts(
        transaction,
        authority,
        request.rootEntityId,
        request.branchRef,
      );
      await this.persistOutbox(transaction, authority, before);
      await this.persistProjection(
        transaction,
        authority,
        request.rootEntityId,
        request.branchRef,
      );
      return { authority, result };
    });
    this.delegate = committed.authority;
    return committed.result;
  }

  readActiveView(
    rootEntityId: string,
    branchRef: string,
  ): MemoryActiveView {
    return this.delegate.readActiveView(rootEntityId, branchRef);
  }

  listCommitRecords(
    rootEntityId: string,
    branchRef: string,
    afterSequence = 0,
  ): CloudCommitRecord[] {
    return this.delegate.listCommitRecords(
      rootEntityId,
      branchRef,
      afterSequence,
    );
  }

  listConflicts(rootEntityId: string, branchRef: string) {
    return this.delegate.listConflicts(rootEntityId, branchRef);
  }

  listOutbox(afterSequence = 0) {
    return this.delegate.listOutbox(afterSequence);
  }

  commitWatermark(): number {
    return this.delegate.commitWatermark();
  }

  headCommitId(
    rootEntityId: string,
    branchRef: string,
  ): string | undefined {
    return this.delegate.headCommitId(rootEntityId, branchRef);
  }

  private static async loadState(
    transaction: PostgresTransaction,
    authorityKey: string,
    seed: MemoryAuthoritySeed,
    lock: boolean,
  ): Promise<PersistedAuthorityState> {
    const result = await transaction.query<StateRow>(
      `SELECT payload
         FROM team_memory_authority_state
        WHERE authority_key = $1${lock ? " FOR UPDATE" : ""}`,
      [authorityKey],
    );
    return result.rows[0]?.payload ?? {
      seed: clone(seed),
      requests: [],
    };
  }

  private static async ensureState(
    transaction: PostgresTransaction,
    authorityKey: string,
    seed: MemoryAuthoritySeed,
  ): Promise<void> {
    const initial: PersistedAuthorityState = {
      seed: clone(seed),
      requests: [],
    };
    await transaction.query(
      `INSERT INTO team_memory_authority_state
         (authority_key, payload, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (authority_key) DO NOTHING`,
      [authorityKey, JSON.stringify(initial)],
    );
  }

  private async persistRecords(
    transaction: PostgresTransaction,
    records: CloudCommitRecord[],
  ): Promise<void> {
    for (const record of records) {
      await transaction.query(
        `INSERT INTO team_memory_commits
           (authority_key, sequence, commit_id, root_entity_id,
            target_branch_ref, stored_branch_ref, client_mutation_id,
            status, conflict_keys, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
         ON CONFLICT (authority_key, commit_id) DO NOTHING`,
        [
          this.authorityKey,
          record.sequence,
          record.commit.id,
          record.commit.rootEntityId,
          record.targetBranchRef,
          record.storedBranchRef,
          record.clientMutationId,
          record.status,
          JSON.stringify(record.conflictKeys),
          JSON.stringify(record.commit),
        ],
      );
      for (const operation of record.operations) {
        await transaction.query(
          `INSERT INTO team_memory_operations
             (authority_key, operation_id, commit_id, root_entity_id,
              branch_ref, payload)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           ON CONFLICT (authority_key, operation_id) DO NOTHING`,
          [
            this.authorityKey,
            operation.id,
            operation.commitId,
            operation.rootEntityId,
            operation.branchRef,
            JSON.stringify(operation),
          ],
        );
      }
    }
  }

  private async persistConflicts(
    transaction: PostgresTransaction,
    authority: InMemoryCloudMemoryAuthority,
    rootEntityId: string,
    branchRef: string,
  ): Promise<void> {
    for (const conflict of authority.listConflicts(
      rootEntityId,
      branchRef,
    )) {
      await transaction.query(
        `INSERT INTO team_memory_conflicts
           (authority_key, conflict_id, root_entity_id, target_branch_ref,
            conflict_branch_ref, status, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (authority_key, conflict_id) DO UPDATE
           SET status = EXCLUDED.status, payload = EXCLUDED.payload`,
        [
          this.authorityKey,
          conflict.id,
          conflict.rootEntityId,
          conflict.targetBranchRef,
          conflict.conflictBranchRef,
          conflict.status,
          JSON.stringify(conflict),
        ],
      );
    }
  }

  private async persistOutbox(
    transaction: PostgresTransaction,
    authority: InMemoryCloudMemoryAuthority,
    afterSequence: number,
  ): Promise<void> {
    for (const event of authority.listOutbox(afterSequence)) {
      await transaction.query(
        `INSERT INTO team_memory_outbox
           (authority_key, event_id, sequence, root_entity_id, branch_ref,
            kind, commit_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (authority_key, event_id) DO NOTHING`,
        [
          this.authorityKey,
          event.id,
          event.sequence,
          event.rootEntityId,
          event.branchRef,
          event.kind,
          event.commitId,
        ],
      );
    }
  }

  private async persistProjection(
    transaction: PostgresTransaction,
    authority: InMemoryCloudMemoryAuthority,
    rootEntityId: string,
    branchRef: string,
  ): Promise<void> {
    const projection = authority.readActiveView(rootEntityId, branchRef);
    await transaction.query(
      `INSERT INTO team_memory_active_projections
         (authority_key, root_entity_id, branch_ref, commit_watermark,
          payload, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now())
       ON CONFLICT (authority_key, root_entity_id, branch_ref) DO UPDATE
         SET commit_watermark = EXCLUDED.commit_watermark,
             payload = EXCLUDED.payload,
             updated_at = now()`,
      [
        this.authorityKey,
        rootEntityId,
        branchRef,
        authority.commitWatermark(),
        JSON.stringify(projection),
      ],
    );
  }
}
