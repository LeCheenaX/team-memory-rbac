import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ClaudeCodeTeamMemoryHooks } from "../src/adapters/claude-code/hooks.ts";
import { OpenClawTeamMemoryPlugin } from "../src/adapters/openclaw/plugin.ts";
import {
  bootstrapDevelopment,
  TeamMemoryRuntime,
} from "../src/adapters/runtime/development-stack.ts";
import { TeamMemoryGateway } from "../src/adapters/runtime/gateway.ts";
import { unitTestRuntimeConfig } from "./support/runtime-config.ts";

const now = "2026-06-30T00:00:00.000Z";

test("OpenClaw plugin and Claude Code hooks run against a local gateway without HTTP or sync", async () => {
  const directory = await mkdtemp(join(tmpdir(), "team-memory-rbac-local-hosts-"));
  const runtime = await TeamMemoryRuntime.create(unitTestRuntimeConfig({
    directory,
    databaseName: "local-hosts.db",
  }));
  try {
    const admin = await bootstrapDevelopment(runtime, {
      rootEntityId: "root-local-hosts",
      userId: "user-local-hosts",
      displayName: "Local Host User",
      sessionId: "session-local-hosts-admin",
      sessionExpiresAt: "2030-01-01T00:00:00.000Z",
      now,
    });
    const gateway = new TeamMemoryGateway(runtime, {
      retrieval: "active-view",
      projectWrites: false,
    });
    const onboarded = await gateway.onboardAgent(admin.token, {
      agentId: "agent-local-hosts",
      delegationId: "delegation-local-hosts",
      sessionId: "session-local-hosts",
      sessionExpiresAt: "2030-01-01T00:00:00.000Z",
    });
    const token = onboarded.session.token;

    const openclaw = OpenClawTeamMemoryPlugin.fromGateway({
      gateway,
      token,
      mode: "team_memory_replaces_native",
    });
    assert.deepEqual(
      openclaw.tools().map((tool) => tool.name),
      ["memory_search", "memory_catalog", "memory_write"],
    );
    await openclaw.call("memory_write", {
      clientMutationId: "local-openclaw-memory",
      target: {
        kind: "memory_entity",
        name: "Local OpenClaw Offline Memory",
      },
      patch: {
        title: "Local OpenClaw Offline Memory",
        description: "OpenClaw works through the local gateway",
        tags: ["local"],
      },
    });
    const openclawSearch = await openclaw.call("memory_search", {
      text: "Local OpenClaw Offline Memory",
    }) as { value: { items: unknown[] } };
    assert.equal(openclawSearch.value.items.length, 1);

    const hooks = ClaudeCodeTeamMemoryHooks.fromGateway({ gateway, token });
    await hooks.stop({
      hook_event_name: "Stop",
      prompt: "Run local Claude Code offline memory",
      session_id: "local-claude-code",
    });
    const recall = await hooks.userPromptSubmit({
      hook_event_name: "UserPromptSubmit",
      prompt: "Recall local Claude Code offline memory",
      session_id: "local-claude-code",
    });
    assert.match(
      recall.hookSpecificOutput.additionalContext ?? "",
      /local Claude Code offline memory/i,
    );
  } finally {
    runtime.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
