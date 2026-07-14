import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ClaudeCodeTeamMemoryHooks } from "../src/adapters/claude-code/hooks.ts";
import { TeamMemoryHttpClient } from "../src/adapters/http/client.ts";
import { createTeamMemoryServer } from "../src/adapters/http/server.ts";
import { OpenClawTeamMemoryPlugin } from "../src/adapters/openclaw/plugin.ts";
import {
  bootstrapDevelopment,
  TeamMemoryRuntime,
} from "../src/adapters/runtime/development-stack.ts";
import { TeamMemoryGateway } from "../src/adapters/runtime/gateway.ts";
import { unitTestRuntimeConfig } from "./support/runtime-config.ts";

const now = "2026-06-30T00:00:00.000Z";

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "team-memory-rbac-host-"));
  const runtime = await TeamMemoryRuntime.create(unitTestRuntimeConfig({
    directory,
    databaseName: "host-lifecycle.db",
  }));
  runtime.ingestion.ingest = async () => {
    throw new Error("test vector store unavailable");
  };
  const admin = await bootstrapDevelopment(runtime, {
    rootEntityId: "root-host",
    userId: "user-host",
    displayName: "Host User",
    sessionId: "session-host-admin",
    sessionExpiresAt: "2030-01-01T00:00:00.000Z",
    now,
  });
  const gateway = new TeamMemoryGateway(runtime, {
    retrieval: "active-view",
    projectWrites: false,
  });
  const server = createTeamMemoryServer(gateway);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const token = await onboard(baseUrl, admin.token);
  return { directory, runtime, gateway, server, baseUrl, token, admin };
}

async function close(fixture: Awaited<ReturnType<typeof setup>>): Promise<void> {
  await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  fixture.server.closeAllConnections();
  fixture.server.closeIdleConnections();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await new Promise<void>((resolve) => setImmediate(resolve));
  fixture.runtime.close();
  await rm(fixture.directory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}

const connectorFetch: typeof fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set("connection", "close");
  return fetch(input, { ...init, headers });
};

async function onboard(baseUrl: string, token: string): Promise<string> {
  const response = await connectorFetch(`${baseUrl}/admin/agents/onboard`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      agentId: "agent-host",
      delegationId: "delegation-host",
      sessionId: "session-host-agent",
      sessionExpiresAt: "2030-01-01T00:00:00.000Z",
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const payload = JSON.parse(text) as { value: { session: { token: string } } };
  return payload.value.session.token;
}

async function writeMemory(client: TeamMemoryHttpClient): Promise<void> {
  await client.write({
    operations: [
      {
        target: "memory_entity",
        op: "create",
        properties: {
          name: "Hermes rollout checklist",
          title: "Hermes rollout checklist",
          description: "Always recall the Hermes provider fixture requirements.",
          tags: ["hermes", "provider"],
        },
      },
    ],
  });
}

function searchItems<T>(result: unknown): T[] {
  if (
    result !== null &&
    typeof result === "object" &&
    "items" in result &&
    Array.isArray((result as { items: unknown }).items)
  ) {
    return (result as { items: T[] }).items;
  }
  if (
    result !== null &&
    typeof result === "object" &&
    "value" in result
  ) {
    return searchItems<T>((result as { value: unknown }).value);
  }
  throw new Error("search result did not include items");
}

test("host lifecycle recall injects trusted-boundary context and capture writes success and failure paths", async () => {
  const fixture = await setup();
  try {
    const client = new TeamMemoryHttpClient({
      baseUrl: fixture.baseUrl,
      token: fixture.token,
      fetch: connectorFetch,
    });
    await writeMemory(client);

    const recalled = await client.recallHostMemory("hermes", {
      sessionId: "hermes-session",
      userPrompt: "What are the Hermes provider fixture requirements?",
    }) as { text: string; memoryIds: string[] };
    assert.match(recalled.text, /team-memory-context/);
    assert.match(recalled.text, /Hermes provider fixture requirements/);
    assert.ok(recalled.memoryIds.length > 0);

    const captured = await client.captureHostMemory("hermes", {
      sessionId: "hermes-session",
      outcome: "failure",
      userPrompt: "Implement Hermes mem0 provider",
      errorSummary: "Provider callback payload was missing",
    }) as {
      status: string;
      resourceId: string;
      revisionId: string;
      chunkIds: string[];
      extractionCandidates: Array<Record<string, unknown>>;
      extra: Record<string, unknown>;
    };
    assert.equal(captured.status, "captured");
    assert.match(captured.resourceId, /^host-capture-resource:/);
    assert.match(captured.revisionId, /^host-capture-revision:/);
    const lifecycleLog = captured.extra.lifecycleLog as Array<{ event?: string }>;
    const ingestionFailed = lifecycleLog.some((entry) =>
      entry.event === "lifecycle.resource_ingest_failed"
    );
    assert.ok(captured.chunkIds.length > 0 || ingestionFailed);
    assert.ok(captured.extractionCandidates.some((operation) =>
      operation.target === "memory_entity" && operation.op === "create"
    ));
    assert.ok(captured.extractionCandidates.some((operation) =>
      operation.target === "memory_entity_branch" && operation.op === "create"
    ));
    if (captured.chunkIds.length > 0) {
      assert.ok(captured.extractionCandidates.some((operation) =>
        operation.target === "memory_relation" &&
        operation.op === "create" &&
        operation.type === "refers_to"
      ));
    }
    assert.equal(captured.extra.host, "hermes");
    assert.equal(captured.extra.sessionId, "hermes-session");
    assert.equal(captured.extra.outcome, "failure");
    assert.equal(captured.extra.userPrompt, "Implement Hermes mem0 provider");
    assert.equal(captured.extra.errorSummary, "Provider callback payload was missing");
    assert.deepEqual(captured.extra.captureLayers, [
      "L1:conversation_resource",
      "L1:resource_chunk",
      "candidate:structured_memory_operations",
    ]);

    const layerIds = captured.extra.layerIds as Record<string, string>;
    assert.equal(layerIds.resourceId, captured.resourceId);
    assert.equal(layerIds.revisionId, captured.revisionId);

    const view = fixture.runtime.history.readActiveView("root-host", "main");
    assert.ok(!view.entities.some(({ id }) => id.startsWith("host-capture:")));
    assert.ok(!view.entityBranches.some(({ title }) =>
      title.includes("hermes failure path:")
    ));
    assert.ok(view.resources.some(({ id, sourceType }) =>
      id === captured.resourceId && sourceType === "conversation"
    ));
    const matchingChunks = view.resourceChunks.filter(({ resourceId, text }) =>
      resourceId === captured.resourceId &&
      text.includes("Provider callback payload was missing")
    );
    if (captured.chunkIds.length > 0) {
      assert.ok(matchingChunks.some(({ id }) => captured.chunkIds.includes(id)));
    } else {
      assert.ok(ingestionFailed);
    }

    if (captured.chunkIds.length > 0) {
      const l1 = await client.search({
        query: "Provider callback payload was missing",
        layer: "L1",
      });
      assert.ok(searchItems<{ kind: string; chunk?: { id: string } }>(l1).some((item) =>
        item.kind === "resource_chunk" &&
        item.chunk?.id !== undefined &&
        captured.chunkIds.includes(item.chunk.id)
      ));
    }
    const l2 = await client.search({
      query: "Provider callback payload was missing",
      layer: "L2",
    });
    assert.equal(searchItems<{ kind: string }>(l2).some((item) =>
      item.kind === "relation"
    ), false);
    const l3 = await client.search({
      query: "Provider callback payload was missing",
      layer: "L3",
    });
    assert.ok(searchItems<{ kind: string; entity?: { id: string } }>(l3).some((item) =>
      item.kind === "entity" && item.entity?.id?.startsWith("host-capture:") === true
    ) === false);
    await exerciseLegacyHostMigration(fixture);
  } finally {
    await close(fixture);
  }
});

async function exerciseLegacyHostMigration(
  fixture: Awaited<ReturnType<typeof setup>>,
): Promise<void> {
    const imported = await fixture.gateway.importResource(fixture.admin.token, {
      clientMutationId: "legacy-resource",
      resourceId: "resource-legacy-host",
      revisionId: "revision-legacy-host",
      commitId: "commit-legacy-resource",
      title: "Legacy Hermes conversation",
      sourceType: "conversation",
      content: "User: Project Atlas stores corrected facts\nAssistant: Corrected fact conflicts with the older branch.",
      metadata: {
        host: "hermes",
        sessionId: "legacy-hermes",
        outcome: "success",
        layer: "L1",
      },
    });
    assert.equal((imported as { resource: { id: string } }).resource.id, "resource-legacy-host");
    const chunkId = "chunk-legacy-host";

    await fixture.runtime.history.execute({
      subject: { kind: "user", userId: "user-host" },
      rootEntityId: "root-host",
      taskScope: { rootEntityId: "root-host" },
      branchRef: "main",
      action: "commit",
      resourceKind: "memory_entity",
      clientMutationId: "seed-legacy-host-capture",
      commit: {
        id: "commit-legacy-host-capture",
        message: "Seed old host capture shape",
      },
      operation: {
        kind: "create_entity",
        id: "operation-legacy-entity",
        entity: {
          id: "host-capture:legacy",
          rootEntityId: "root-host",
          currentBranchId: "host-capture-branch:legacy",
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      },
      operations: [
        {
          kind: "create_entity",
          id: "operation-legacy-entity",
          entity: {
            id: "host-capture:legacy",
            rootEntityId: "root-host",
            currentBranchId: "host-capture-branch:legacy",
            status: "active",
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          kind: "create_entity_branch",
          id: "operation-legacy-branch",
          branch: {
            id: "host-capture-branch:legacy",
            entityId: "host-capture:legacy",
            rootEntityId: "root-host",
            branchRef: "main",
            title: "hermes success path: Project Atlas facts",
            description: [
              "Host: hermes",
              "Session: legacy-hermes",
              "Outcome: success",
              "User prompt: Project Atlas stores corrected facts",
              "Final assistant message: Corrected fact conflicts with the older branch.",
            ].join("\n"),
            tags: ["host-memory", "hermes", "success"],
            importance: 0.8,
            confidence: 0.75,
            status: "active",
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          kind: "create_resource_chunk",
          id: "operation-legacy-resource-chunk",
          chunk: {
            id: chunkId,
            rootEntityId: "root-host",
            resourceId: "resource-legacy-host",
            chunkIndex: 0,
            text: "User: Project Atlas stores corrected facts\nAssistant: Corrected fact conflicts with the older branch.",
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          kind: "create_relation",
          id: "operation-legacy-evidence",
          relation: {
            id: "relation-legacy-evidence",
            rootEntityId: "root-host",
            sourceKind: "memory_entity",
            sourceId: "host-capture:legacy",
            targetKind: "resource_chunk",
            targetId: chunkId,
            relationType: "refers_to",
            role: "l1_evidence",
            weight: 1,
            confidence: 0.9,
            branchRef: "main",
            status: "active",
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
      authorization: {
        allowed: true,
        reason: "test",
        subjectId: "user-host",
        subjectKind: "user",
        rootEntityId: "root-host",
        action: "commit",
        resourceKind: "memory_entity",
        matchedRoles: ["role-root-admin"],
        missingActions: [],
        constraints: {},
      },
    });

    const client = new TeamMemoryHttpClient({
      baseUrl: fixture.baseUrl,
      token: fixture.admin.token,
      fetch: connectorFetch,
    });
    const migrated = await client.migrateLegacyHostCaptures({
      clientMutationId: "migrate-legacy-host-capture",
    }) as {
      migratedEntityIds: string[];
      tombstonedEntityIds: string[];
      commitIds: string[];
      operations: Array<Record<string, unknown>>;
    };
    assert.deepEqual(migrated.migratedEntityIds, ["host-capture:legacy"]);
    assert.deepEqual(migrated.tombstonedEntityIds, ["host-capture:legacy"]);
    assert.ok(migrated.commitIds.length >= 2);
    assert.ok(migrated.operations.some((operation) =>
      operation.target === "memory_relation" &&
      operation.op === "create" &&
      operation.type === "refers_to"
    ));

    const view = fixture.runtime.history.readActiveView("root-host", "main");
    assert.ok(!view.entities.some((entity) => entity.id === "host-capture:legacy"));
    assert.ok(view.resources.some((resource) => resource.id === "resource-legacy-host"));
    assert.ok(view.resourceChunks.some((chunk) => chunk.id === chunkId));
    const realEntity = view.entities.find((entity) => entity.name === "Project Atlas facts");
    assert.ok(realEntity);
    assert.ok(view.entityBranches.some((branch) =>
      branch.entityId === realEntity.id &&
      branch.description.includes("Corrected fact conflicts")
    ));
    assert.ok(fixture.runtime.history.listCommitRecords("root-host", "main").some((record) =>
      record.commit.id === "commit-legacy-host-capture"
    ));
}

test("Claude Code hooks and OpenClaw plugin call the shared lifecycle endpoints", async () => {
  const calls: Array<{ host: string; input: Record<string, unknown> }> = [];
  const lifecycle = {
    async recallHostMemory(host: string, input: Record<string, unknown>) {
      calls.push({ host, input });
      return { text: "<team-memory-context>remember me</team-memory-context>" };
    },
    async captureHostMemory(host: string, input: Record<string, unknown>) {
      calls.push({ host, input });
      return { status: "captured" };
    },
  };
  const hooks = new ClaudeCodeTeamMemoryHooks(lifecycle);
  const response = await hooks.userPromptSubmit({
    prompt: "ship it",
    session_id: "claude-session",
  });
  assert.equal(
    response.hookSpecificOutput.additionalContext,
    "<team-memory-context>remember me</team-memory-context>",
  );
  await hooks.stopFailure({
    hook_event_name: "StopFailure",
    session_id: "claude-session",
    transcript_path: "/tmp/transcript.jsonl",
  });
  await hooks.sessionEnd({
    session_id: "claude-session",
    final_assistant_message: "done",
  });
  await hooks.teammateIdle({
    session_id: "claude-session",
    prompt: "idle prompt",
  });
  await hooks.preCompact({
    session_id: "claude-session",
    error_summary: "about to compact",
  });
  assert.deepEqual(calls.map((call) => call.host), [
    "claude_code",
    "claude_code",
    "claude_code",
    "claude_code",
    "claude_code",
  ]);
  assert.equal(calls[1]?.input.outcome, "failure");
  assert.equal(calls[2]?.input.outcome, "success");
  assert.equal(calls[3]?.input.outcome, "unknown");
  assert.equal(calls[4]?.input.outcome, "unknown");

  const openclawFetch: typeof fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    assert.equal(url.pathname, "/host/openclaw/capture");
    assert.equal(init?.method, "POST");
    return new Response(
      JSON.stringify({ value: { status: "captured" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const openclaw = new OpenClawTeamMemoryPlugin({
    baseUrl: "https://memory.example",
    token: "token",
    mode: "team_memory_replaces_native",
    fetch: openclawFetch,
  });
  assert.equal(
    (openclaw.manifest().lifecycle as { recall: string }).recall,
    "host/openclaw/recall",
  );
  assert.deepEqual(
    (openclaw.manifest().lifecycle as {
      autoCapture: { event: string; layers: string[] };
    }).autoCapture.layers,
    [
      "L1:conversation_resource",
      "L1:resource_chunk",
      "candidate:structured_memory_operations",
    ],
  );
  const captured = await openclaw.agentEnd({
    sessionId: "openclaw-session",
    userPrompt: "finish OpenClaw active memory",
    finalAssistantMessage: "done",
  }) as { status: string };
  assert.equal(captured.status, "captured");
});
