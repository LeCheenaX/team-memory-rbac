import { createClient } from "@libsql/client";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, parse, resolve } from "node:path";

const MEMORY_TABLES_IN_DELETE_ORDER = [
  "history_resolutions",
  "history_operations",
  "history_conflicts",
  "history_commits",
  "history_branch_heads",
  "history_sync_watermarks",
  "history_idempotency",
  "history_request_journal",
  "memory_relations",
  "bm25_documents",
] as const;

const VECTOR_COLLECTIONS = [
  "memory_entities",
  "memory_entity_branches",
  "resource_chunks",
] as const;

export interface TestMemoryMaintenanceConfig {
  runtimeMode: string;
  libsql: { url: string; authToken?: string };
  qdrant: { url: string; apiKey?: string };
  cas: {
    backend: "filesystem" | "object_store";
    directory?: string;
  };
}

export interface ClearTestMemoryOptions {
  skipVectors?: boolean;
  skipFilesystemCas?: boolean;
  objectStoreCasDirectory?: string;
}

export interface ClearTestMemoryResult {
  status: "cleared";
  sqlTableCount: number;
  vectorsCleared: boolean;
  filesystemCasCleared: boolean;
  objectStoreCasCleared: boolean;
  preserved: "rbac_*";
}

/**
 * Clears non-core memory from a local test runtime while preserving RBAC.
 *
 * The narrow interface owns the complete test-maintenance policy. Callers do
 * not know table names, vector collection names, deletion order, or CAS rules.
 */
export async function clearTestMemory(
  config: TestMemoryMaintenanceConfig,
  options: ClearTestMemoryOptions = {},
): Promise<ClearTestMemoryResult> {
  assertTestConfig(config);
  const sqlTableCount = await clearSqlMemory(config);
  if (options.skipVectors !== true) await clearVectorMemory(config);
  const filesystemCasCleared = options.skipFilesystemCas === true
    ? false
    : await clearFilesystemCas(config);
  const objectStoreCasCleared = await clearObjectStoreCas(
    config,
    options.objectStoreCasDirectory,
  );

  return {
    status: "cleared",
    sqlTableCount,
    vectorsCleared: options.skipVectors !== true,
    filesystemCasCleared,
    objectStoreCasCleared,
    preserved: "rbac_*",
  };
}

function assertTestConfig(config: TestMemoryMaintenanceConfig): void {
  if (config.runtimeMode !== "Dev") {
    throw new Error("Refusing to clear memory: runtimeMode must be Dev");
  }
  const libsqlUrl = new URL(config.libsql.url);
  if (
    libsqlUrl.protocol !== "file:" &&
    !["libsql", "localhost", "127.0.0.1"].includes(libsqlUrl.hostname)
  ) {
    throw new Error(`Refusing to clear non-test libSQL host: ${libsqlUrl.hostname}`);
  }
  const qdrantUrl = new URL(config.qdrant.url);
  if (!["qdrant", "localhost", "127.0.0.1"].includes(qdrantUrl.hostname)) {
    throw new Error(`Refusing to clear non-test Qdrant host: ${qdrantUrl.hostname}`);
  }
}

async function clearSqlMemory(config: TestMemoryMaintenanceConfig): Promise<number> {
  const client = createClient({
    url: config.libsql.url,
    ...(config.libsql.authToken === undefined
      ? {}
      : { authToken: config.libsql.authToken }),
  });
  try {
    const tables = await client.execute(
      "select name from sqlite_master where type = 'table'",
    );
    const existing = new Set(tables.rows.map((row) => String(row.name)));
    const statements = MEMORY_TABLES_IN_DELETE_ORDER
      .filter((table) => existing.has(table))
      .map((table) => `delete from ${table}`);
    if (statements.length > 0) await client.batch(statements, "write");
    return statements.length;
  } finally {
    client.close();
  }
}

async function clearVectorMemory(config: TestMemoryMaintenanceConfig): Promise<void> {
  for (const collection of VECTOR_COLLECTIONS) {
    const baseUrl = `${config.qdrant.url.replace(/\/$/, "")}/`;
    const response = await fetch(new URL(`collections/${collection}`, baseUrl), {
      method: "DELETE",
      headers: config.qdrant.apiKey === undefined
        ? {}
        : { "api-key": config.qdrant.apiKey },
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `Failed to delete Qdrant collection ${collection}: HTTP ${response.status}`,
      );
    }
  }
}

async function clearFilesystemCas(config: TestMemoryMaintenanceConfig): Promise<boolean> {
  if (config.cas.backend !== "filesystem") return false;
  const directory = config.cas.directory;
  if (directory === undefined || directory.length === 0) {
    throw new Error("Filesystem CAS directory is required");
  }
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  return true;
}

async function clearObjectStoreCas(
  config: TestMemoryMaintenanceConfig,
  directory: string | undefined,
): Promise<boolean> {
  if (config.cas.backend !== "object_store" || directory === undefined) {
    return false;
  }
  const resolved = resolve(directory);
  if (resolved === parse(resolved).root) {
    throw new Error("Refusing to clear an object-store filesystem root");
  }
  await mkdir(resolved, { recursive: true });
  const entries = await readdir(resolved);
  for (const entry of entries) {
    await rm(join(resolved, entry), { recursive: true, force: true });
  }
  return true;
}

