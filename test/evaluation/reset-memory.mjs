#!/usr/bin/env node
import { createClient } from "@libsql/client";
import { mkdir, readFile, rm } from "node:fs/promises";

const memoryTables = [
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
const vectorCollections = ["memory_entities", "memory_entity_branches", "resource_chunks"];
const rootEntityId = "root:test1-local";
const expectedDatabasePath = "/workspace/.data/test1-local-hermes/team-memory.db";
const configIndex = process.argv.indexOf("--config");
const configPath = configIndex < 0 ? undefined : process.argv[configIndex + 1];
if (!configPath) throw new Error("Usage: reset-memory.mjs --config <path>");

const config = JSON.parse(await readFile(configPath, "utf8"));
if (config.runtimeMode !== "Dev") {
  throw new Error("Refusing reset: the hermes-local runtimeMode must be Dev");
}
const libsqlUrl = new URL(config.libsql?.url);
if (libsqlUrl.protocol !== "file:" || libsqlUrl.pathname !== expectedDatabasePath) {
  throw new Error(`Refusing unexpected hermes-local libSQL path: ${libsqlUrl.pathname}`);
}
const casDirectory = config.cas?.directory;
if (
  config.cas?.backend !== "filesystem"
  || casDirectory !== "/workspace/.data/test1-local-hermes/cas"
) {
  throw new Error(`Refusing unexpected hermes-local CAS path: ${casDirectory}`);
}
const qdrantUrl = new URL(config.qdrant?.url);
if (qdrantUrl.origin !== "http://qdrant:6333") {
  throw new Error(`Refusing unexpected hermes-local Qdrant origin: ${qdrantUrl.origin}`);
}

const client = createClient({ url: config.libsql.url });
let deletedTables = 0;
try {
  const tables = await client.execute("select name from sqlite_master where type = 'table'");
  const existing = new Set(tables.rows.map((row) => String(row.name)));
  const statements = memoryTables
    .filter((table) => existing.has(table))
    .map((table) => `delete from ${table}`);
  if (statements.length > 0) await client.batch(statements, "write");
  deletedTables = statements.length;
} finally {
  client.close();
}

for (const collection of vectorCollections) {
  const response = await fetch(
    new URL(`collections/${collection}/points/delete?wait=true`, qdrantUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filter: { must: [{ key: "rootEntityId", match: { value: rootEntityId } }] },
      }),
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`failed to clear ${collection}: HTTP ${response.status} ${await response.text()}`);
  }
}

await rm(casDirectory, { recursive: true, force: true });
await mkdir(casDirectory, { recursive: true });
console.log(JSON.stringify({
  status: "cleared",
  rootEntityId,
  deletedTables,
  vectorCollections,
  casDirectory,
  preserved: ["rbac_*", "/root/.hermes provider/model/API-key configuration"],
}));
