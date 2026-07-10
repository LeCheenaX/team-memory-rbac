import { loadRuntimeConfig } from "../src/adapters/runtime/development-stack.ts";
import { requiredCiChecks } from "../src/adapters/runtime/operations.ts";

const config = loadRuntimeConfig({
  LIBSQL_URL: "file:smoke.db",
  TEAM_MEMORY_RUNTIME_MODE: "development",
  CAS_BACKEND: "filesystem",
  CAS_DIRECTORY: ".scratch/smoke-cas",
  QDRANT_URL: "http://127.0.0.1:6333",
  EMBEDDING_PROVIDER: "deterministic",
  OBJECT_STORE_URL: "http://127.0.0.1:9000",
});

if (requiredCiChecks().length === 0) {
  throw new Error("CI checks must be declared");
}

console.log(JSON.stringify({ status: "ok", configKeys: Object.keys(config).sort() }));
