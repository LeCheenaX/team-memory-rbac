import { createTeamMemoryServer } from "../adapters/http/server.ts";
import { loadRuntimeConfig, TeamMemoryRuntime } from "../adapters/runtime/development-stack.ts";

const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port <= 0) throw new Error("PORT must be a positive integer");
const runtime = await TeamMemoryRuntime.create(loadRuntimeConfig(process.env));
const server = createTeamMemoryServer(runtime);
server.listen(port, "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => { runtime.close(); process.exit(0); }));
}
