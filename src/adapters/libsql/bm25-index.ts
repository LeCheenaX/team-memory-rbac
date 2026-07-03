import type {
  Bm25Document,
  Bm25Index,
  Bm25SearchOptions,
  Bm25SearchResult,
} from "../../ingestion/bm25.ts";
import { bm25Internals } from "../../ingestion/bm25.ts";
import type { LibsqlClient } from "./client.ts";

const BM25_SCHEMA = `
create table if not exists bm25_documents (
  id text primary key,
  root_entity_id text not null,
  branch_ref text not null,
  resource_id text not null,
  revision_id text not null,
  chunk_id text not null,
  status text not null,
  text text not null,
  payload_json text not null
);
create index if not exists bm25_documents_scope
  on bm25_documents(root_entity_id, branch_ref, resource_id, revision_id, status);
`;

function parseDocument(row: unknown): Bm25Document {
  const raw = (row as Record<string, unknown>).payload_json;
  if (typeof raw !== "string") {
    throw new Error("BM25 document row is invalid");
  }
  return JSON.parse(raw) as Bm25Document;
}

export class LibsqlBm25Index implements Bm25Index {
  private readonly client: LibsqlClient;

  private constructor(client: LibsqlClient) {
    this.client = client;
  }

  static async create(client: LibsqlClient): Promise<LibsqlBm25Index> {
    const index = new LibsqlBm25Index(client);
    await index.initialize();
    return index;
  }

  async initialize(): Promise<void> {
    await this.client.executeMultiple(BM25_SCHEMA);
  }

  async upsertDocuments(documents: Bm25Document[]): Promise<void> {
    const transaction = await this.client.transaction("write");
    try {
      for (const document of documents) {
        await transaction.execute({
          sql: `insert into bm25_documents(
            id, root_entity_id, branch_ref, resource_id, revision_id,
            chunk_id, status, text, payload_json
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(id) do update set
            root_entity_id = excluded.root_entity_id,
            branch_ref = excluded.branch_ref,
            resource_id = excluded.resource_id,
            revision_id = excluded.revision_id,
            chunk_id = excluded.chunk_id,
            status = excluded.status,
            text = excluded.text,
            payload_json = excluded.payload_json`,
          args: [
            document.id,
            document.rootEntityId,
            document.branchRef,
            document.resourceId,
            document.revisionId,
            document.chunkId,
            document.status,
            document.text,
            JSON.stringify(document),
          ],
        });
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback().catch(() => undefined);
      throw error;
    } finally {
      transaction.close();
    }
  }

  async replaceRevision(input: {
    rootEntityId: string;
    branchRef: string;
    resourceId: string;
    revisionId: string;
    documents: Bm25Document[];
  }): Promise<void> {
    const transaction = await this.client.transaction("write");
    try {
      await transaction.execute({
        sql: "delete from bm25_documents where root_entity_id = ? and branch_ref = ? and resource_id = ? and revision_id = ?",
        args: [
          input.rootEntityId,
          input.branchRef,
          input.resourceId,
          input.revisionId,
        ],
      });
      for (const document of input.documents) {
        await transaction.execute({
          sql: `insert into bm25_documents(
            id, root_entity_id, branch_ref, resource_id, revision_id,
            chunk_id, status, text, payload_json
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            document.id,
            document.rootEntityId,
            document.branchRef,
            document.resourceId,
            document.revisionId,
            document.chunkId,
            document.status,
            document.text,
            JSON.stringify(document),
          ],
        });
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback().catch(() => undefined);
      throw error;
    } finally {
      transaction.close();
    }
  }

  async search(options: Bm25SearchOptions): Promise<Bm25SearchResult[]> {
    const clauses = [
      "root_entity_id = ?",
      "branch_ref = ?",
      "status = 'active'",
    ];
    const args: string[] = [options.rootEntityId, options.branchRef];
    if (options.allowedResourceIds !== undefined) {
      if (options.allowedResourceIds.length === 0) {
        return [];
      }
      clauses.push(
        `resource_id in (${options.allowedResourceIds.map(() => "?").join(", ")})`,
      );
      args.push(...options.allowedResourceIds);
    }
    if (options.deniedResourceIds !== undefined) {
      for (const id of options.deniedResourceIds) {
        clauses.push("resource_id != ?");
        args.push(id);
      }
    }
    const result = await this.client.execute({
      sql: `select payload_json from bm25_documents where ${clauses.join(" and ")}`,
      args,
    });
    return bm25Internals.scoreDocuments(
      result.rows.map(parseDocument),
      options.text,
      options.limit ?? 20,
    );
  }
}
