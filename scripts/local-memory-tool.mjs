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

const { HermesAgentAdapter } = await import("../src/adapters/agent/transports.ts");
const { TeamMemoryRuntime, loadRuntimeConfigFile } = await import("../src/adapters/runtime/development-stack.ts");
const { TeamMemoryGateway } = await import("../src/adapters/runtime/gateway.ts");
const { readStoredSession } = await import("../src/adapters/local/session-store.ts");
const { parseRuntimeConfigArgs, resolveConfigPath } = await import("./runtime-config-args.mjs");

const parsedArgs = parseRuntimeConfigArgs(process.argv.slice(2), import.meta.url);
const [command, toolName, rawPayload] = parsedArgs.args;
const storedSession = await readStoredSession(process.env);
const token = process.env.LOCAL_SESSION_TOKEN === undefined || process.env.LOCAL_SESSION_TOKEN.length === 0
  ? (storedSession?.agentSessionToken ?? storedSession?.sessionToken)
  : process.env.LOCAL_SESSION_TOKEN;
if (token === undefined || token.length === 0) {
  throw new Error("Team Memory is not logged in. Run `team-memory login <userId> <password>` first.");
}
const runtime = await TeamMemoryRuntime.create(await loadRuntimeConfigFile(resolveConfigPath(parsedArgs.configPath)));
try {
  const gateway = new TeamMemoryGateway(runtime);
  const adapter = new HermesAgentAdapter(gateway);
  if (command === "identity") {
    console.log(JSON.stringify(await adapter.resolvePrincipal(token), null, 2));
  } else if (command === "tools") {
    console.log(JSON.stringify(await adapter.listTools(token), null, 2));
  } else if (command === "call") {
    if (toolName === undefined) throw new Error("tool name is required");
    const payload = rawPayload === undefined ? {} : JSON.parse(rawPayload);
    console.log(JSON.stringify(await adapter.invokeTool(token, toolName, payload), null, 2));
  } else if (command === "host-recall") {
    if (toolName === undefined) throw new Error("host name is required");
    const payload = rawPayload === undefined ? {} : JSON.parse(rawPayload);
    console.log(JSON.stringify(await gateway.recallHostMemory(token, {
      ...payload,
      host: toolName,
    }), null, 2));
  } else if (command === "host-capture") {
    if (toolName === undefined) throw new Error("host name is required");
    const payload = rawPayload === undefined ? {} : JSON.parse(rawPayload);
    console.log(JSON.stringify(await gateway.captureHostMemory(token, {
      ...payload,
      host: toolName,
    }), null, 2));
  } else {
    throw new Error("usage: local-memory-tool <identity|tools|call|host-recall|host-capture> [toolNameOrHost] [jsonPayload]");
  }
} finally {
  runtime.close();
}
