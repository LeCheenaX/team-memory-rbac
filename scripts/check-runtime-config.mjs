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

const { loadRuntimeConfigFile, TeamMemoryRuntime } = await import("../src/adapters/runtime/development-stack.ts");
const { parseRuntimeConfigArgs, resolveConfigPath } = await import("./runtime-config-args.mjs");

const parsedArgs = parseRuntimeConfigArgs(process.argv.slice(2), import.meta.url);
const runtime = await TeamMemoryRuntime.create(await loadRuntimeConfigFile(resolveConfigPath(parsedArgs.configPath)));
try {
  await runtime.ready();
  console.log(`team-memory-rbac runtime config ok: ${parsedArgs.configPath}`);
} finally {
  runtime.close();
}
