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

const now = "2026-06-30T00:00:00.000Z";

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "team-memory-rbac-host-"));
  const runtime = await TeamMemoryRuntime.create({
    libsqlUrl: `file:${join(directory, "host-lifecycle.db")}`,
    casDirectory: join(directory, "cas"),
    qdrantUrl: "http://127.0.0.1:6333",
    objectStoreUrl: "http://127.0.0.1:9000",
  });
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
  return { directory, runtime, server, baseUrl, token };
}

async function close(fixture: Awaited<ReturnType<typeof setup>>): Promise<void> {
  fixture.server.close();
  fixture.server.closeAllConnections();
  fixture.server.closeIdleConnections();
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
    clientMutationId: "host-lifecycle-memory",
    target: {
      kind: "memory_entity",
      name: "Hermes rollout checklist",
    },
    patch: {
      title: "Hermes rollout checklist",
      description: "Always recall the Hermes provider fixture requirements.",
      tags: ["hermes", "provider"],
    },
  });
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
    }) as { status: string; branchId: string; extra: Record<string, unknown> };
    assert.equal(captured.status, "captured");
    assert.deepEqual(captured.extra, {
      host: "hermes",
      sessionId: "hermes-session",
      outcome: "failure",
      userPrompt: "Implement Hermes mem0 provider",
      errorSummary: "Provider callback payload was missing",
    });

    const rerecalled = await client.recallHostMemory("hermes", {
      sessionId: "hermes-session",
      userPrompt: "Provider callback payload was missing",
    }) as { text: string; memoryIds: string[] };
    assert.ok(rerecalled.memoryIds.includes(captured.branchId));
    assert.match(rerecalled.text, /failure/);
    assert.match(rerecalled.text, /Extra:/);
    assert.match(rerecalled.text, /Provider callback payload was missing/);
  } finally {
    await close(fixture);
  }
});

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
  assert.deepEqual(calls.map((call) => call.host), ["claude_code", "claude_code"]);
  assert.equal(calls[1]?.input.outcome, "failure");

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
  const captured = await openclaw.capturePath({
    sessionId: "openclaw-session",
    outcome: "success",
    userPrompt: "finish OpenClaw active memory",
    finalAssistantMessage: "done",
  }) as { status: string };
  assert.equal(captured.status, "captured");
});
