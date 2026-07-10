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

const {
  ClaudeCodeAgentAdapter,
  HermesAgentAdapter,
  OpenClawAgentAdapter,
} = await import("../src/adapters/agent/transports.ts");
const { ClaudeCodeTeamMemoryHooks } = await import("../src/adapters/claude-code/hooks.ts");
const { OpenClawTeamMemoryPlugin } = await import("../src/adapters/openclaw/plugin.ts");
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
const expiresAt = required("LOCAL_HOST_SESSION_EXPIRES_AT");
const now = new Date().toISOString();

const hostConfigs = [
  {
    host: "hermes",
    agentId: process.env.LOCAL_HERMES_AGENT_ID ?? "agent:local-hermes",
    delegationId: process.env.LOCAL_HERMES_DELEGATION_ID ?? "delegation:local-hermes",
    sessionId: process.env.LOCAL_HERMES_SESSION_ID ?? "session:local-hermes",
    adapter: (gateway) => new HermesAgentAdapter(gateway),
  },
  {
    host: "openclaw",
    agentId: process.env.LOCAL_OPENCLAW_AGENT_ID ?? "agent:local-openclaw",
    delegationId: process.env.LOCAL_OPENCLAW_DELEGATION_ID ?? "delegation:local-openclaw",
    sessionId: process.env.LOCAL_OPENCLAW_SESSION_ID ?? "session:local-openclaw",
    adapter: (gateway) => new OpenClawAgentAdapter(gateway),
  },
  {
    host: "claude_code",
    agentId: process.env.LOCAL_CLAUDE_CODE_AGENT_ID ?? "agent:local-claude-code",
    delegationId: process.env.LOCAL_CLAUDE_CODE_DELEGATION_ID ?? "delegation:local-claude-code",
    sessionId: process.env.LOCAL_CLAUDE_CODE_SESSION_ID ?? "session:local-claude-code",
    adapter: (gateway) => new ClaudeCodeAgentAdapter(gateway),
  },
];

async function writeAndSearch(adapter, token, host) {
  const entityId = `entity:local-${host}-smoke`;
  const branchId = `branch:local-${host}-smoke`;
  const title = `Local ${host} RBAC Memory Smoke`;
  await adapter.invokeTool(token, "memory.write", {
    clientMutationId: `local-${host}-smoke-entity`,
    action: "write_entity",
    resourceKind: "memory_entity",
    commit: { id: `commit:local-${host}-smoke-entity` },
    operation: {
      kind: "create_entity",
      id: `operation:local-${host}-smoke-entity`,
      entity: {
        id: entityId,
        rootEntityId,
        currentBranchId: branchId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  await adapter.invokeTool(token, "memory.write", {
    clientMutationId: `local-${host}-smoke-branch`,
    action: "write_entity_branch",
    resourceKind: "memory_entity_branch",
    commit: { id: `commit:local-${host}-smoke-branch` },
    operation: {
      kind: "create_entity_branch",
      id: `operation:local-${host}-smoke-branch`,
      branch: {
        id: branchId,
        entityId,
        rootEntityId,
        branchRef: "main",
        title,
        description: `${host} can write and recall memory without an HTTP server or sync.`,
        tags: ["local-host-smoke", host],
        importance: 1,
        confidence: 1,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  return adapter.invokeTool(token, "memory.search", {
    query: title,
    limit: 5,
  });
}

async function forgedIdentityRejected(adapter, token, host) {
  try {
    await adapter.invokeTool(token, "memory.search", {
      rootEntityId: "root:forged",
      query: `Local ${host}`,
    });
    return false;
  } catch (error) {
    return error instanceof Error &&
      error.message.includes("request payload cannot provide rootEntityId");
  }
}

const runtime = await TeamMemoryRuntime.create(loadRuntimeConfig(process.env));
try {
  const gateway = new TeamMemoryGateway(runtime);
  const results = [];
  const tokens = new Map();

  for (const config of hostConfigs) {
    const onboarded = await gateway.onboardAgent(adminToken, {
      agentId: config.agentId,
      delegationId: config.delegationId,
      sessionId: config.sessionId,
      sessionExpiresAt: expiresAt,
      displayName: `Local ${config.host} Smoke`,
    });
    const token = onboarded.session.token;
    tokens.set(config.host, token);
    const adapter = config.adapter(gateway);
    const principal = await adapter.resolvePrincipal(token);
    const tools = await adapter.listTools(token);
    const search = await writeAndSearch(adapter, token, config.host);
    results.push({
      host: config.host,
      path: "agent_adapter",
      principal,
      visibleTools: tools.map((tool) => tool.name),
      search,
      forgedIdentityRejected: await forgedIdentityRejected(adapter, token, config.host),
    });
  }

  const openclaw = OpenClawTeamMemoryPlugin.fromGateway({
    gateway,
    token: tokens.get("openclaw"),
    mode: "team_memory_replaces_native",
  });
  const openclawRecall = await openclaw.recallContext({
    sessionId: "local-openclaw",
    userPrompt: "Recall the local OpenClaw RBAC memory smoke.",
    limit: 5,
  });

  const claude = ClaudeCodeTeamMemoryHooks.fromGateway({
    gateway,
    token: tokens.get("claude_code"),
  });
  await claude.stop({
    hook_event_name: "Stop",
    prompt: "Run local Claude Code memory smoke.",
    session_id: "local-claude-code",
  });
  const claudeRecall = await claude.userPromptSubmit({
    hook_event_name: "UserPromptSubmit",
    prompt: "Recall local Claude Code memory smoke.",
    session_id: "local-claude-code",
  });

  console.log(JSON.stringify({
    mode: "local_hosts_no_http_no_sync",
    results,
    openclawPlugin: {
      tools: openclaw.tools().map((tool) => tool.name),
      recall: openclawRecall,
    },
    claudeCodeHooks: claudeRecall,
  }, null, 2));
} finally {
  runtime.close();
}
