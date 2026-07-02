#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.execArgv.includes("--experimental-strip-types")) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { env: process.env, stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}

const { createTeamMemoryServer } = await import("../src/adapters/http/server.ts");
const { loadRuntimeConfig, TeamMemoryRuntime } = await import("../src/adapters/runtime/development-stack.ts");

const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port <= 0) throw new Error("PORT must be a positive integer");
const runtime = await TeamMemoryRuntime.create(loadRuntimeConfig(process.env));
const server = createTeamMemoryServer(runtime);
server.listen(port, "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => { runtime.close(); process.exit(0); }));
}
