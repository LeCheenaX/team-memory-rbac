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
const { parseRuntimeConfigArgs, resolveConfigPath } = await import("./runtime-config-args.mjs");

const parsedArgs = parseRuntimeConfigArgs(process.argv.slice(2), import.meta.url);

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be configured explicitly`);
  }
  return value;
}

const adminToken = required("ADMIN_TOKEN");
const agentId = required("LOCAL_HERMES_AGENT_ID");
const delegationId = required("LOCAL_HERMES_DELEGATION_ID");
const sessionId = required("LOCAL_HERMES_SESSION_ID");
const expiresAt = required("LOCAL_HERMES_SESSION_EXPIRES_AT");

const runtime = await TeamMemoryRuntime.create(await loadRuntimeConfigFile(resolveConfigPath(parsedArgs.configPath)));
try {
  const gateway = new TeamMemoryGateway(runtime);
  const onboarded = await gateway.onboardAgent(adminToken, {
    agentId,
    delegationId,
    sessionId,
    sessionExpiresAt: expiresAt,
    displayName: "Local Hermes Smoke",
  });
  const hermes = new HermesAgentAdapter(gateway);
  const token = onboarded.session.token;
  const principal = await hermes.resolvePrincipal(token);
  const tools = await hermes.listTools(token);

  await hermes.invokeTool(token, "memory.write", {
    clientMutationId: "local-hermes-smoke-memory",
    target: {
      kind: "memory_entity",
      name: "Local Hermes RBAC Memory Smoke",
    },
    patch: {
      title: "Local Hermes RBAC Memory Smoke",
      description: "Single Hermes adapter can write and recall memory without an HTTP server or sync.",
      tags: ["local-hermes-smoke"],
    },
  });

  const search = await hermes.invokeTool(token, "memory.search", {
    query: "Local Hermes RBAC Memory Smoke",
    limit: 5,
  });

  let forgedIdentityRejected = false;
  try {
    await hermes.invokeTool(token, "memory.search", {
      rootEntityId: "root:forged",
      query: "Local Hermes",
    });
  } catch (error) {
    forgedIdentityRejected = error instanceof Error &&
      error.message.includes("request payload cannot provide rootEntityId");
  }

  console.log(JSON.stringify({
    mode: "single_hermes_local_no_http_no_sync",
    principal,
    visibleTools: tools.map((tool) => tool.name),
    search,
    forgedIdentityRejected,
  }, null, 2));
} finally {
  runtime.close();
}
