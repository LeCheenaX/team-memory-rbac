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

const runtime = await TeamMemoryRuntime.create(loadRuntimeConfig(process.env));
try {
  const cli = new TeamManagementCli(new TeamMemoryGateway(runtime));
  const result = await cli.run(
    process.env.TEAM_MEMORY_TOKEN,
    parseTeamManagementCommand(process.argv.slice(2)),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  runtime.close();
}
