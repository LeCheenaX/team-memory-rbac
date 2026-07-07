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
const { TeamMemoryRuntime, loadRuntimeConfig } = await import("../src/adapters/runtime/development-stack.ts");
const { TeamMemoryGateway } = await import("../src/adapters/runtime/gateway.ts");

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be configured explicitly`);
  }
  return value;
}

const adminToken = required("ADMIN_TOKEN");
const rootEntityId = required("BOOTSTRAP_ROOT_ENTITY_ID");
const agentId = required("LOCAL_HERMES_AGENT_ID");
const delegationId = required("LOCAL_HERMES_DELEGATION_ID");
const sessionId = required("LOCAL_HERMES_SESSION_ID");
const expiresAt = required("LOCAL_HERMES_SESSION_EXPIRES_AT");
const now = new Date().toISOString();

const runtime = await TeamMemoryRuntime.create(loadRuntimeConfig(process.env));
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
    clientMutationId: "local-hermes-smoke-entity",
    action: "write_entity",
    resourceKind: "memory_entity",
    commit: { id: "commit:local-hermes-smoke-entity" },
    operation: {
      kind: "create_entity",
      id: "operation:local-hermes-smoke-entity",
      entity: {
        id: "entity:local-hermes-smoke",
        rootEntityId,
        currentBranchId: "branch:local-hermes-smoke",
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    },
  });

  await hermes.invokeTool(token, "memory.write", {
    clientMutationId: "local-hermes-smoke-branch",
    action: "write_entity_branch",
    resourceKind: "memory_entity_branch",
    commit: { id: "commit:local-hermes-smoke-branch" },
    operation: {
      kind: "create_entity_branch",
      id: "operation:local-hermes-smoke-branch",
      branch: {
        id: "branch:local-hermes-smoke",
        entityId: "entity:local-hermes-smoke",
        rootEntityId,
        branchRef: "main",
        title: "Local Hermes RBAC Memory Smoke",
        description: "Single Hermes adapter can write and recall memory without an HTTP server or sync.",
        tags: ["local-hermes-smoke"],
        importance: 1,
        confidence: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    },
  });

  const search = await hermes.invokeTool(token, "memory.search", {
    query: {
      kind: "entity",
      text: "Local Hermes RBAC Memory Smoke",
      limit: 5,
    },
  });

  let forgedIdentityRejected = false;
  try {
    await hermes.invokeTool(token, "memory.search", {
      rootEntityId: "root:forged",
      query: { kind: "entity", text: "Local Hermes" },
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
