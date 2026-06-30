import { TeamManagementCli, parseTeamManagementCommand } from "../src/adapters/cli/team-management.ts";
import { TeamMemoryGateway } from "../src/adapters/runtime/gateway.ts";
import { loadRuntimeConfig, TeamMemoryRuntime } from "../src/adapters/runtime/development-stack.ts";

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
