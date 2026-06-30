import type { MemoryRelation } from "../../src/contracts/memory.ts";
import type { MemoryRelationStore } from "../../src/memory/stores.ts";
import type { LibsqlClient } from "./client.ts";

const RELATION_SCHEMA = `
create table if not exists memory_relations (
  id text primary key,
  root_entity_id text not null,
  branch_ref text not null,
  source_kind text not null,
  source_id text not null,
  target_kind text not null,
  target_id text not null,
  relation_type text not null,
  status text not null,
  weight real not null,
  confidence real not null,
  created_at text not null,
  updated_at text not null,
  payload_json text not null
);
create index if not exists memory_relations_source
  on memory_relations(root_entity_id, branch_ref, source_id, relation_type, status);
create index if not exists memory_relations_target
  on memory_relations(root_entity_id, branch_ref, target_id, relation_type, status);
`;

function rowValue(row: unknown, key: string): unknown {
  return (row as Record<string, unknown>)[key];
}

function relationFromRow(row: unknown): MemoryRelation {
  const payload = rowValue(row, "payload_json");
  if (typeof payload !== "string") {
    throw new Error("memory relation row is invalid");
  }
  return JSON.parse(payload) as MemoryRelation;
}

export class LibsqlMemoryRelationStore implements MemoryRelationStore {
  private readonly client: LibsqlClient;

  private constructor(client: LibsqlClient) {
    this.client = client;
  }

  static async create(
    client: LibsqlClient,
  ): Promise<LibsqlMemoryRelationStore> {
    const store = new LibsqlMemoryRelationStore(client);
    await store.initialize();
    return store;
  }

  async initialize(): Promise<void> {
    await this.client.executeMultiple(RELATION_SCHEMA);
  }

  async upsert(relation: MemoryRelation): Promise<void> {
    await this.client.execute({
      sql: `insert into memory_relations(
        id, root_entity_id, branch_ref, source_kind, source_id, target_kind,
        target_id, relation_type, status, weight, confidence, created_at,
        updated_at, payload_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        root_entity_id = excluded.root_entity_id,
        branch_ref = excluded.branch_ref,
        source_kind = excluded.source_kind,
        source_id = excluded.source_id,
        target_kind = excluded.target_kind,
        target_id = excluded.target_id,
        relation_type = excluded.relation_type,
        status = excluded.status,
        weight = excluded.weight,
        confidence = excluded.confidence,
        updated_at = excluded.updated_at,
        payload_json = excluded.payload_json`,
      args: [
        relation.id,
        relation.rootEntityId,
        relation.branchRef,
        relation.sourceKind,
        relation.sourceId,
        relation.targetKind,
        relation.targetId,
        relation.relationType,
        relation.status,
        relation.weight,
        relation.confidence,
        relation.createdAt,
        relation.updatedAt,
        JSON.stringify(relation),
      ],
    });
  }

  async get(id: string): Promise<MemoryRelation | undefined> {
    const result = await this.client.execute({
      sql: "select payload_json from memory_relations where id = ?",
      args: [id],
    });
    const row = result.rows[0];
    return row === undefined ? undefined : relationFromRow(row);
  }

  async list(options: {
    rootEntityId: string;
    branchRef: string;
    sourceId?: string;
    relationTypes?: MemoryRelation["relationType"][];
    status?: MemoryRelation["status"];
  }): Promise<MemoryRelation[]> {
    const clauses = ["root_entity_id = ?", "branch_ref = ?"];
    const args: Array<string | number | null> = [
      options.rootEntityId,
      options.branchRef,
    ];
    if (options.sourceId !== undefined) {
      clauses.push("source_id = ?");
      args.push(options.sourceId);
    }
    if (options.status !== undefined) {
      clauses.push("status = ?");
      args.push(options.status);
    }
    if (options.relationTypes !== undefined) {
      if (options.relationTypes.length === 0) {
        return [];
      }
      clauses.push(
        `relation_type in (${options.relationTypes.map(() => "?").join(", ")})`,
      );
      args.push(...options.relationTypes);
    }
    const result = await this.client.execute({
      sql: `select payload_json from memory_relations where ${clauses.join(" and ")} order by rowid`,
      args,
    });
    return result.rows.map(relationFromRow);
  }

  async tombstone(id: string, updatedAt: string): Promise<void> {
    const existing = await this.get(id);
    if (existing === undefined) {
      return;
    }
    await this.upsert({
      ...existing,
      status: "tombstoned",
      updatedAt,
    });
  }
}
