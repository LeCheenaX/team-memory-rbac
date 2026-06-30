import type { InStatement, Transaction } from "@libsql/client";
import type {
  AuthorizedMemoryRequest,
} from "../../src/permission-router.ts";
import {
  InMemoryCloudMemoryAuthority,
  type CloudCommitRecord,
  type CloudMemoryWriteCommand,
  type CloudMemoryWriteResult,
  type ConflictResolutionCommand,
  type ConflictResolutionResult,
  type MemoryConflict,
} from "../../src/history/cloud-authority.ts";
import type {
  HistoryAuthority,
  HistoryProjectionEvent,
  HistoryReplayRequest,
} from "../../src/history/authority.ts";
import type { LibsqlClient } from "./client.ts";

const HISTORY_SCHEMA = `
create table if not exists history_request_journal (
  sequence integer primary key autoincrement,
  request_kind text not null,
  request_json text not null
);
create table if not exists history_idempotency (
  root_entity_id text not null,
  branch_ref text not null,
  client_mutation_id text not null,
  request_kind text not null,
  request_json text not null,
  result_json text not null,
  primary key (root_entity_id, branch_ref, client_mutation_id, request_kind)
);
create table if not exists history_commits (
  sequence integer primary key,
  commit_id text not null unique,
  root_entity_id text not null,
  target_branch_ref text not null,
  stored_branch_ref text not null,
  client_mutation_id text not null,
  status text not null,
  conflict_keys_json text not null,
  payload_json text not null
);
create unique index if not exists history_commits_idempotency on history_commits(root_entity_id, target_branch_ref, client_mutation_id);
create table if not exists history_operations (
  operation_id text primary key,
  commit_id text not null,
  root_entity_id text not null,
  branch_ref text not null,
  operation_kind text not null,
  input_json text not null,
  provenance_json text,
  created_at text not null
);
create table if not exists history_branch_heads (
  root_entity_id text not null,
  branch_ref text not null,
  head_commit_id text,
  status text not null,
  updated_at text not null,
  primary key (root_entity_id, branch_ref)
);
create table if not exists history_conflicts (
  conflict_id text primary key,
  root_entity_id text not null,
  target_branch_ref text not null,
  conflict_branch_ref text not null,
  incoming_commit_id text not null,
  status text not null,
  resolution_commit_id text,
  payload_json text not null
);
create table if not exists history_resolutions (
  resolution_commit_id text primary key,
  conflict_id text not null,
  incoming_commit_id text not null,
  resolution_kind text not null
);
create table if not exists history_sync_watermarks (
  replica_id text primary key,
  root_entity_id text not null,
  branch_ref text not null,
  commit_watermark integer not null,
  permission_watermark text,
  updated_at text not null
);
`;

type JournalEntry =
  | { kind: "write"; request: AuthorizedMemoryRequest<CloudMemoryWriteCommand> }
  | { kind: "resolve"; request: AuthorizedMemoryRequest<ConflictResolutionCommand> };

function clone<T>(value: T): T { return structuredClone(value); }

function asRow(row: unknown): Record<string, unknown> { return row as Record<string, unknown>; }

/**
 * Durable Cloud History authority. The libSQL journal is the source needed to
 * reconstruct the authority; normalized history tables are maintained in the
 * same write transaction for reporting and sync consumers.
 */
export class LibsqlHistoryAuthority implements HistoryAuthority {
  private authority = new InMemoryCloudMemoryAuthority();
  private readonly client: LibsqlClient;

  private constructor(client: LibsqlClient) { this.client = client; }

  static async create(client: LibsqlClient): Promise<LibsqlHistoryAuthority> {
    const authority = new LibsqlHistoryAuthority(client);
    await authority.initialize();
    return authority;
  }

  async initialize(): Promise<void> {
    await this.client.executeMultiple(HISTORY_SCHEMA);
    this.authority = await this.rehydrate(this.client);
  }

  async execute(request: AuthorizedMemoryRequest<CloudMemoryWriteCommand>): Promise<CloudMemoryWriteResult> {
    const transaction = await this.client.transaction("write");
    try {
      const idempotent = await this.idempotent<CloudMemoryWriteResult>(transaction, "write", request);
      if (idempotent !== undefined) { await transaction.rollback(); return idempotent; }
      const fresh = await this.rehydrate(transaction);
      const result = await fresh.execute(clone(request));
      await transaction.execute({ sql: "insert into history_request_journal(request_kind, request_json) values (?, ?)", args: ["write", JSON.stringify({ kind: "write", request })] });
      await this.storeIdempotent(transaction, "write", request, result);
      await this.persistProjection(transaction, fresh, request.rootEntityId, request.branchRef);
      await transaction.commit();
      this.authority = fresh;
      return result;
    } catch (error) {
      await transaction.rollback().catch(() => undefined);
      throw error;
    } finally { transaction.close(); }
  }

  async resolveConflict(request: AuthorizedMemoryRequest<ConflictResolutionCommand>): Promise<ConflictResolutionResult> {
    const transaction = await this.client.transaction("write");
    try {
      const idempotent = await this.idempotent<ConflictResolutionResult>(transaction, "resolve", request);
      if (idempotent !== undefined) { await transaction.rollback(); return idempotent; }
      const fresh = await this.rehydrate(transaction);
      const result = await fresh.resolveConflict(clone(request));
      await transaction.execute({ sql: "insert into history_request_journal(request_kind, request_json) values (?, ?)", args: ["resolve", JSON.stringify({ kind: "resolve", request })] });
      await this.storeIdempotent(transaction, "resolve", request, result);
      await this.persistProjection(transaction, fresh, request.rootEntityId, request.branchRef);
      await transaction.commit();
      this.authority = fresh;
      return result;
    } catch (error) {
      await transaction.rollback().catch(() => undefined);
      throw error;
    } finally { transaction.close(); }
  }

  listCommitRecords(rootEntityId: string, branchRef: string, afterSequence = 0): CloudCommitRecord[] {
    return this.authority.listCommitRecords(rootEntityId, branchRef, afterSequence);
  }

  listConflicts(rootEntityId: string, branchRef: string): MemoryConflict[] {
    return this.authority.listConflicts(rootEntityId, branchRef);
  }

  commitWatermark(): number { return this.authority.commitWatermark(); }

  readActiveView(rootEntityId: string, branchRef: string) {
    return this.authority.readActiveView(rootEntityId, branchRef);
  }

  headCommitId(rootEntityId: string, branchRef: string): string | undefined {
    return this.authority.headCommitId(rootEntityId, branchRef);
  }

  async replay(request: HistoryReplayRequest): Promise<HistoryProjectionEvent[]> {
    return this.authority.listCommitRecords(request.rootEntityId, request.branchRef, request.afterSequence)
      .filter((record) => record.status === "accepted")
      .map((record) => ({ sequence: record.sequence, commit: record.commit, operations: record.operations }));
  }

  async setSyncWatermark(input: { replicaId: string; rootEntityId: string; branchRef: string; commitWatermark: number; permissionWatermark?: string; updatedAt: string }): Promise<void> {
    await this.client.execute({
      sql: "insert into history_sync_watermarks(replica_id, root_entity_id, branch_ref, commit_watermark, permission_watermark, updated_at) values (?, ?, ?, ?, ?, ?) on conflict(replica_id) do update set root_entity_id = excluded.root_entity_id, branch_ref = excluded.branch_ref, commit_watermark = excluded.commit_watermark, permission_watermark = excluded.permission_watermark, updated_at = excluded.updated_at",
      args: [input.replicaId, input.rootEntityId, input.branchRef, input.commitWatermark, input.permissionWatermark ?? null, input.updatedAt],
    });
  }

  private async rehydrate(client: Pick<LibsqlClient, "execute">): Promise<InMemoryCloudMemoryAuthority> {
    const result = await client.execute("select request_json from history_request_journal order by sequence");
    const restored = new InMemoryCloudMemoryAuthority();
    for (const candidate of result.rows) {
      const raw = asRow(candidate).request_json;
      if (typeof raw !== "string") throw new Error("history journal row is invalid");
      const entry = JSON.parse(raw) as JournalEntry;
      if (entry.kind === "write") await restored.execute(entry.request);
      else if (entry.kind === "resolve") await restored.resolveConflict(entry.request);
      else throw new Error("history journal entry kind is invalid");
    }
    return restored;
  }

  private async idempotent<TResult>(transaction: Transaction, kind: "write" | "resolve", request: { rootEntityId: string; branchRef: string; clientMutationId: string }): Promise<TResult | undefined> {
    const result = await transaction.execute({ sql: "select request_json, result_json from history_idempotency where root_entity_id = ? and branch_ref = ? and client_mutation_id = ? and request_kind = ?", args: [request.rootEntityId, request.branchRef, request.clientMutationId, kind] });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    const storedRequest = row.request_json;
    if (typeof storedRequest !== "string" || storedRequest !== JSON.stringify(request)) throw new Error("clientMutationId was already used for a different command");
    const storedResult = row.result_json;
    if (typeof storedResult !== "string") throw new Error("idempotency record is invalid");
    return JSON.parse(storedResult) as TResult;
  }

  private async storeIdempotent(transaction: Transaction, kind: "write" | "resolve", request: { rootEntityId: string; branchRef: string; clientMutationId: string }, result: unknown): Promise<void> {
    await transaction.execute({ sql: "insert into history_idempotency(root_entity_id, branch_ref, client_mutation_id, request_kind, request_json, result_json) values (?, ?, ?, ?, ?, ?)", args: [request.rootEntityId, request.branchRef, request.clientMutationId, kind, JSON.stringify(request), JSON.stringify(result)] });
  }

  private async persistProjection(transaction: Transaction, authority: InMemoryCloudMemoryAuthority, rootEntityId: string, branchRef: string): Promise<void> {
    const records = authority.listCommitRecords(rootEntityId, branchRef);
    const conflicts = authority.listConflicts(rootEntityId, branchRef);
    const statements: InStatement[] = [
      { sql: "delete from history_resolutions where conflict_id in (select conflict_id from history_conflicts where root_entity_id = ? and target_branch_ref = ?)", args: [rootEntityId, branchRef] },
      { sql: "delete from history_operations where commit_id in (select commit_id from history_commits where root_entity_id = ? and target_branch_ref = ?)", args: [rootEntityId, branchRef] },
      { sql: "delete from history_conflicts where root_entity_id = ? and target_branch_ref = ?", args: [rootEntityId, branchRef] },
      { sql: "delete from history_commits where root_entity_id = ? and target_branch_ref = ?", args: [rootEntityId, branchRef] },
    ];
    const resolutionStatements: InStatement[] = [];
    for (const record of records) {
      statements.push({
        sql: "insert into history_commits(sequence, commit_id, root_entity_id, target_branch_ref, stored_branch_ref, client_mutation_id, status, conflict_keys_json, payload_json) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        args: [record.sequence, record.commit.id, rootEntityId, branchRef, record.storedBranchRef, record.clientMutationId, record.status, JSON.stringify(record.conflictKeys), JSON.stringify(record)],
      });
      for (const operation of record.operations) {
        statements.push({
          sql: "insert into history_operations(operation_id, commit_id, root_entity_id, branch_ref, operation_kind, input_json, provenance_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
          args: [operation.id, operation.commitId, operation.rootEntityId, operation.branchRef, operation.kind, JSON.stringify(operation.input), operation.provenance === undefined ? null : JSON.stringify(operation.provenance), operation.createdAt],
        });
      }
      if (record.resolution !== undefined) {
        for (const [index, conflictId] of record.resolution.resolvedConflictIds.entries()) {
          resolutionStatements.push({
            sql: "insert into history_resolutions(resolution_commit_id, conflict_id, incoming_commit_id, resolution_kind) values (?, ?, ?, ?)",
            args: [record.commit.id, conflictId, record.resolution.resolvedIncomingCommitIds[index] ?? "", record.resolution.resolutionKind],
          });
        }
      }
    }
    for (const conflict of conflicts) {
      statements.push({
        sql: "insert into history_conflicts(conflict_id, root_entity_id, target_branch_ref, conflict_branch_ref, incoming_commit_id, status, resolution_commit_id, payload_json) values (?, ?, ?, ?, ?, ?, ?, ?)",
        args: [conflict.id, conflict.rootEntityId, conflict.targetBranchRef, conflict.conflictBranchRef, conflict.incomingCommitId, conflict.status, conflict.resolvedByCommitId ?? null, JSON.stringify(conflict)],
      });
    }
    statements.push(...resolutionStatements);
    const head = authority.headCommitId(rootEntityId, branchRef);
    statements.push({
      sql: "insert into history_branch_heads(root_entity_id, branch_ref, head_commit_id, status, updated_at) values (?, ?, ?, 'active', ?) on conflict(root_entity_id, branch_ref) do update set head_commit_id = excluded.head_commit_id, status = excluded.status, updated_at = excluded.updated_at",
      args: [rootEntityId, branchRef, head ?? null, new Date().toISOString()],
    });
    await transaction.batch(statements);
  }
}
