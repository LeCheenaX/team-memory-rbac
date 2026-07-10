import { loadRuntimeConfig } from "../src/adapters/runtime/development-stack.ts";
import { requiredCiChecks } from "../src/adapters/runtime/operations.ts";

const config = loadRuntimeConfig({
  runtimeMode: "Dev",
  libsql: { url: "file:smoke.db" },
  cas: { backend: "filesystem", directory: ".scratch/smoke-cas" },
  qdrant: { url: "http://127.0.0.1:6333" },
  embedding: { provider: "deterministic", url: "deterministic://smoke-dev" },
});

if (requiredCiChecks().length === 0) {
  throw new Error("CI checks must be declared");
}

console.log(JSON.stringify({ status: "ok", configKeys: Object.keys(config).sort() }));
