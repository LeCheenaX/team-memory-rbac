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

const { TeamManagementCli, parseTeamManagementCommand } = await import("../src/adapters/cli/team-management.ts");
const { TeamMemoryGateway } = await import("../src/adapters/runtime/gateway.ts");
const { loadRuntimeConfig, TeamMemoryRuntime } = await import("../src/adapters/runtime/development-stack.ts");

const command = parseTeamManagementCommand(process.argv.slice(2));

function nonEmptyEnv(name) {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

const token = nonEmptyEnv("TEAM_MEMORY_TOKEN") ?? nonEmptyEnv("ADMIN_TOKEN");

if (command[0] !== "health" && (token === undefined || token.length === 0)) {
  console.error(
    "TEAM_MEMORY_TOKEN is required for this command. Set TEAM_MEMORY_TOKEN to a session token, or ADMIN_TOKEN for local administrator commands.",
  );
  process.exit(1);
}

const runtime = await TeamMemoryRuntime.create(loadRuntimeConfig(process.env));
try {
  const cli = new TeamManagementCli(new TeamMemoryGateway(runtime));
  const result = await cli.run(token, command);
  console.log(JSON.stringify(result, null, 2));
} finally {
  runtime.close();
}
