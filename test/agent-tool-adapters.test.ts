import assert from "node:assert/strict";
import test from "node:test";

import {
  createSubAgentDelegation,
  InMemoryAgentSessionAuthority,
  SessionMemorySdk,
  TaskPermissionAnalyzer,
  ToolPermissionAdapter,
  type AgentToolDefinition,
} from "../src/agent/index.ts";
import {
  ClaudeCodeAgentAdapter,
  CodexAgentAdapter,
  HermesAgentAdapter,
  HttpAgentAdapter,
  McpAgentAdapter,
  OpenClawAgentAdapter,
} from "../src/adapters/agent/transports.ts";
import type {
  AgentDelegation,
  Permission,
  Role,
} from "../src/contracts/rbac.ts";
import {
  BUILT_IN_ROLES,
  InMemoryRbacAuthority,
  ScopedPolicyEngine,
} from "../src/rbac/index.ts";

const timestamp = "2026-06-25T00:00:00.000Z";
const later = "2026-06-26T00:00:00.000Z";
const rootEntityId = "root-project-a";

const readPermission: Permission = {
  action: "read",
  resourceKind: "memory_entity",
};
const writePermission: Permission = {
  action: "write_entity",
  resourceKind: "memory_entity",
};

function delegation(
  id: string,
  agentId: string,
  permissions: Permission[],
): AgentDelegation {
  return {
    id,
    agentId,
    ownerUserId: "user-alice",
    rootEntityId,
    permissions,
    delegatedBy: "user-alice",
    delegatedAt: timestamp,
    status: "active",
    expiresAt: later,
  };
}

function setup() {
  const roles = structuredClone(BUILT_IN_ROLES) as Role[];
  const authority = new InMemoryRbacAuthority({
    users: [
      {
        id: "user-alice",
        displayName: "Alice",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    agents: [
      {
        id: "agent-read",
        ownerUserId: "user-alice",
        agentType: "sub_agent",
        displayName: "Read",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "agent-curator",
        ownerUserId: "user-alice",
        agentType: "curator_agent",
        displayName: "Curator",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    roles,
    assignments: [
      {
        id: "assignment-maintainer",
        userId: "user-alice",
        rootEntityId,
        roleId: "role-maintainer",
        assignedBy: "user-admin",
        assignedAt: timestamp,
        status: "active",
      },
    ],
    delegations: [
      delegation("delegation-read", "agent-read", [readPermission]),
      delegation("delegation-curator", "agent-curator", [
        readPermission,
        writePermission,
      ]),
    ],
  });
  const policy = new ScopedPolicyEngine(authority, {
    now: () => new Date(timestamp),
  });
  let id = 0;
  const sessions = new InMemoryAgentSessionAuthority(authority, {
    now: () => new Date(timestamp),
    randomId: () => `tool-${++id}`,
  });
  return { authority, policy, roles, sessions };
}

async function createSession(
  sessions: InMemoryAgentSessionAuthority,
  agentId: string,
  delegationId: string,
) {
  return sessions.create({
    userId: "user-alice",
    agentId,
    rootEntityId,
    taskScope: { rootEntityId },
    delegationId,
    expiresAt: later,
  });
}

test("tool visibility follows effective permissions and direct bypass remains denied", async () => {
  const { authority, policy, sessions } = setup();
  let readCalls = 0;
  let writeCalls = 0;
  const tools: AgentToolDefinition[] = [
    {
      name: "memory.read",
      description: "Read memory",
      action: "read",
      resourceKind: "memory_entity",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        readCalls += 1;
        return "read";
      },
    },
    {
      name: "memory.write",
      description: "Write memory",
      action: "write_entity",
      resourceKind: "memory_entity",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
      },
      execute: async () => {
        writeCalls += 1;
        return "write";
      },
    },
    {
      name: "memory.createRoot",
      description: "Admin",
      action: "create_root_entity",
      resourceKind: "memory_entity",
      inputSchema: { type: "object", properties: {} },
      execute: async () => "admin",
    },
  ];
  const adapter = new ToolPermissionAdapter(
    new SessionMemorySdk(sessions, policy),
    tools,
  );
  const readSession = await createSession(
    sessions,
    "agent-read",
    "delegation-read",
  );
  assert.deepEqual(
    (await adapter.listVisibleTools(readSession.token)).map(
      ({ name }) => name,
    ),
    ["memory.read"],
  );
  const denied = await adapter.invoke(
    readSession.token,
    "memory.write",
    { title: "Bypass" },
  );
  assert.equal(denied.decision.allowed, false);
  assert.equal(writeCalls, 0);

  const curatorSession = await createSession(
    sessions,
    "agent-curator",
    "delegation-curator",
  );
  assert.deepEqual(
    (await adapter.listVisibleTools(curatorSession.token)).map(
      ({ name }) => name,
    ),
    ["memory.read", "memory.write"],
  );
  const written = await adapter.invoke(
    curatorSession.token,
    "memory.write",
    { title: "Allowed" },
  );
  assert.equal(written.decision.allowed, true);
  assert.equal(writeCalls, 1);
  assert.equal(readCalls, 0);

  authority.revokeDelegation("delegation-curator", timestamp);
  await assert.rejects(
    () =>
      adapter.invoke(curatorSession.token, "memory.write", {
        title: "After revoke",
      }),
    /delegation is inactive/,
  );
});

test("tool schemas cannot ask the model for identity fields", () => {
  const { policy, sessions } = setup();
  assert.throws(
    () =>
      new ToolPermissionAdapter(
        new SessionMemorySdk(sessions, policy),
        [
          {
            name: "unsafe",
            description: "Unsafe",
            action: "read",
            resourceKind: "memory_entity",
            inputSchema: {
              type: "object",
              properties: { userId: { type: "string" } },
            },
            execute: async () => undefined,
          },
        ],
      ),
    /forbidden identity field userId/,
  );
});

test("subagent delegation cannot exceed owner, parent, TaskScope, or administrator boundaries", () => {
  const valid = createSubAgentDelegation({
    id: "delegation-child",
    childAgentId: "agent-child",
    ownerUserId: "user-alice",
    parentAgentId: "agent-read",
    rootEntityId,
    requestedPermissions: [readPermission],
    ownerPermissions: [readPermission, writePermission],
    parentPermissions: [readPermission],
    taskScope: { rootEntityId },
    delegatedAt: timestamp,
  });
  assert.deepEqual(valid.permissions, [readPermission]);

  assert.throws(
    () =>
      createSubAgentDelegation({
        id: "delegation-too-wide",
        childAgentId: "agent-child",
        ownerUserId: "user-alice",
        parentAgentId: "agent-read",
        rootEntityId,
        requestedPermissions: [writePermission],
        ownerPermissions: [readPermission, writePermission],
        parentPermissions: [readPermission],
        taskScope: { rootEntityId },
        delegatedAt: timestamp,
      }),
    /exceeds owner permission/,
  );
  assert.throws(
    () =>
      createSubAgentDelegation({
        id: "delegation-admin",
        childAgentId: "agent-child",
        ownerUserId: "user-alice",
        parentAgentId: "agent-read",
        rootEntityId,
        requestedPermissions: [
          {
            action: "create_root_entity",
            resourceKind: "memory_entity",
          },
        ],
        ownerPermissions: [],
        parentPermissions: [],
        taskScope: { rootEntityId },
        delegatedAt: timestamp,
      }),
    /administrator permissions cannot be delegated/,
  );
});

test("TaskPermissionAnalyzer reports granted, missing, roles, and human approval without mutating RBAC", async () => {
  const { policy, roles, sessions } = setup();
  const session = await createSession(
    sessions,
    "agent-read",
    "delegation-read",
  );
  const principal = await sessions.resolve(session.token);
  const analyzer = new TaskPermissionAnalyzer(policy, roles);
  const analysis = await analyzer.analyze(principal, [
    readPermission,
    writePermission,
    {
      action: "create_root_entity",
      resourceKind: "memory_entity",
    },
  ]);

  assert.deepEqual(analysis.grantedPermissions, [readPermission]);
  assert.deepEqual(
    analyzer.summarizeMissing(analysis),
    [
      "write_entity:memory_entity",
      "create_root_entity:memory_entity",
    ],
  );
  assert.equal(analysis.requiresHumanApproval, true);
  assert.equal(analysis.satisfyingRoles.includes("role-root-admin"), true);
});

test("HTTP, MCP, OpenClaw, Hermes, Claude Code, and Codex map the same session contract", async () => {
  const { policy, sessions } = setup();
  const session = await createSession(
    sessions,
    "agent-read",
    "delegation-read",
  );
  const toolAdapter = new ToolPermissionAdapter(
    new SessionMemorySdk(sessions, policy),
    [
      {
        name: "memory.read",
        description: "Read",
        action: "read",
        resourceKind: "memory_entity",
        inputSchema: { type: "object", properties: {} },
        execute: async () => "read",
      },
    ],
  );
  const adapters = [
    new HttpAgentAdapter(sessions, toolAdapter),
    new McpAgentAdapter(sessions, toolAdapter),
    new OpenClawAgentAdapter(sessions, toolAdapter),
    new HermesAgentAdapter(sessions, toolAdapter),
    new ClaudeCodeAgentAdapter(sessions, toolAdapter),
    new CodexAgentAdapter(sessions, toolAdapter),
  ];
  const contexts = await Promise.all(
    adapters.map((adapter) => adapter.resolvePrincipal(session.token)),
  );
  assert.ok(
    contexts.every(
      (context) =>
        JSON.stringify(context) === JSON.stringify(contexts[0]),
    ),
  );
  const decisions = await Promise.all(
    adapters.map((adapter) =>
      adapter.invokeTool(session.token, "memory.read", {}),
    ),
  );
  assert.ok(
    decisions.every(
      (result) =>
        JSON.stringify(result.decision) ===
        JSON.stringify(decisions[0]?.decision),
    ),
  );
});

test("OpenClaw, Claude Code, and Hermes expose host-specific memory integration plans", async () => {
  const { policy, sessions } = setup();
  const session = await createSession(
    sessions,
    "agent-curator",
    "delegation-curator",
  );
  const toolAdapter = new ToolPermissionAdapter(
    new SessionMemorySdk(sessions, policy),
    [
      {
        name: "memory.read",
        description: "Read team memory",
        action: "read",
        resourceKind: "memory_entity",
        inputSchema: { type: "object", properties: {} },
        execute: async () => "search",
      },
      {
        name: "memory.write",
        description: "Write team memory",
        action: "write_entity",
        resourceKind: "memory_entity",
        inputSchema: { type: "object", properties: {} },
        execute: async () => "write",
      },
    ],
  );
  const openClaw = new OpenClawAgentAdapter(sessions, toolAdapter);
  const openClawParallel = await openClaw.createMemoryIntegrationPlan(
    session.token,
    "parallel_native_team_memory",
  );
  assert.equal(openClawParallel.connector, "openclaw_tool_plugin");
  assert.equal(openClawParallel.nativeMemory.disposition, "preserved");
  assert.equal(openClawParallel.teamMemory.canRead, true);
  assert.equal(openClawParallel.teamMemory.canWrite, true);
  const openClawReplacement = await openClaw.createMemoryIntegrationPlan(
    session.token,
    "team_memory_replaces_native",
  );
  assert.equal(
    openClawReplacement.connector,
    "openclaw_active_memory_plugin",
  );
  assert.equal(
    openClawReplacement.nativeMemory.disposition,
    "replaced_by_team_memory",
  );
  assert.equal(
    openClawReplacement.hostConfiguration.settings["plugins.slots.memory"],
    "team-memory-rbac",
  );

  const claudeCode = new ClaudeCodeAgentAdapter(sessions, toolAdapter);
  const claudeParallel = await claudeCode.createMemoryIntegrationPlan(
    session.token,
    "parallel_native_team_memory",
  );
  assert.equal(claudeParallel.connector, "mcp");
  assert.equal(claudeParallel.nativeMemory.disposition, "preserved");
  const claudeReplacement = await claudeCode.createMemoryIntegrationPlan(
    session.token,
    "team_memory_replaces_native",
  );
  assert.equal(claudeReplacement.nativeMemory.disposition, "disabled");
  assert.equal(
    claudeReplacement.hostConfiguration.settings.autoMemoryEnabled,
    false,
  );
  assert.equal(
    claudeReplacement.hostConfiguration.settings
      .CLAUDE_CODE_DISABLE_AUTO_MEMORY,
    "1",
  );

  const hermes = new HermesAgentAdapter(sessions, toolAdapter);
  const hermesReplacement = await hermes.createMemoryIntegrationPlan(
    session.token,
    "team_memory_replaces_native",
  );
  assert.equal(hermesReplacement.connector, "python_adapter");
  assert.equal(
    hermesReplacement.nativeMemory.disposition,
    "not_applicable",
  );
  assert.equal(hermesReplacement.teamMemory.canRead, true);
  assert.equal(hermesReplacement.teamMemory.canWrite, true);
});
