#!/usr/bin/env node
import { createClient } from "@libsql/client";
import { mkdir, readFile, rm } from "node:fs/promises";

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
];

const VECTOR_COLLECTIONS = [
  "memory_entities",
  "memory_entity_branches",
  "resource_chunks",
];

function parseArguments(argv) {
  const configIndex = argv.indexOf("--config");
  if (configIndex < 0 || argv[configIndex + 1] === undefined) {
    throw new Error("Usage: clear-test-memory --config <path> [--skip-vectors] [--skip-cas]");
  }
  return {
    configPath: argv[configIndex + 1],
    skipVectors: argv.includes("--skip-vectors"),
    skipCas: argv.includes("--skip-cas"),
  };
}

function assertTestConfig(config) {
  if (config.runtimeMode !== "Dev") {
    throw new Error("Refusing to clear memory: runtimeMode must be Dev");
  }
  const libsqlUrl = new URL(config.libsql?.url);
  if (libsqlUrl.protocol !== "file:" && !["libsql", "localhost", "127.0.0.1"].includes(libsqlUrl.hostname)) {
    throw new Error(`Refusing to clear non-test libSQL host: ${libsqlUrl.hostname}`);
  }
  const qdrantUrl = new URL(config.qdrant?.url);
  if (!["qdrant", "localhost", "127.0.0.1"].includes(qdrantUrl.hostname)) {
    throw new Error(`Refusing to clear non-test Qdrant host: ${qdrantUrl.hostname}`);
  }
}

async function clearSql(config) {
  const client = createClient({
    url: config.libsql.url,
    ...(config.libsql.authToken === undefined ? {} : { authToken: config.libsql.authToken }),
  });
  try {
    const tables = await client.execute("select name from sqlite_master where type = 'table'");
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

async function clearVectors(config) {
  for (const collection of VECTOR_COLLECTIONS) {
    const response = await fetch(new URL(`collections/${collection}`, `${config.qdrant.url.replace(/\/$/, "")}/`), {
      method: "DELETE",
      headers: config.qdrant.apiKey === undefined ? {} : { "api-key": config.qdrant.apiKey },
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Failed to delete Qdrant collection ${collection}: HTTP ${response.status}`);
    }
  }
}

async function clearFilesystemCas(config) {
  if (config.cas?.backend !== "filesystem") return false;
  const directory = config.cas.directory;
  if (typeof directory !== "string" || directory.length === 0) {
    throw new Error("Filesystem CAS directory is required");
  }
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  return true;
}

const options = parseArguments(process.argv.slice(2));
const config = JSON.parse(await readFile(options.configPath, "utf8"));
assertTestConfig(config);
const sqlTableCount = await clearSql(config);
if (!options.skipVectors) await clearVectors(config);
const casCleared = options.skipCas ? false : await clearFilesystemCas(config);

console.log(JSON.stringify({
  status: "cleared",
  sqlTableCount,
  vectorsCleared: !options.skipVectors,
  filesystemCasCleared: casCleared,
  preserved: "rbac_*",
}));

