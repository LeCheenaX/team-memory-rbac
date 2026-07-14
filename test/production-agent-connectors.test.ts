import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TeamMemoryHttpClient } from "../src/adapters/http/client.ts";
import { createTeamMemoryServer } from "../src/adapters/http/server.ts";
import { TeamMemoryMcpStdioServer } from "../src/adapters/mcp/stdio-server.ts";
import { OpenClawTeamMemoryPlugin } from "../src/adapters/openclaw/plugin.ts";
import {
  bootstrapDevelopment,
  TeamMemoryRuntime,
} from "../src/adapters/runtime/development-stack.ts";
import { TeamMemoryGateway } from "../src/adapters/runtime/gateway.ts";
import { unitTestRuntimeConfig } from "./support/runtime-config.ts";

const now = "2026-06-30T00:00:00.000Z";

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "team-memory-rbac-prod-"));
  const runtime = await TeamMemoryRuntime.create(unitTestRuntimeConfig({
    directory,
    databaseName: "prod-connectors.db",
  }));
  const admin = await bootstrapDevelopment(runtime, {
    rootEntityId: "root-prod",
    userId: "user-prod",
    displayName: "Production User",
    sessionId: "session-prod-admin",
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
  return {
    directory,
    runtime,
    server,
    admin,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function close(
  fixture: Awaited<ReturnType<typeof setup>>,
): Promise<void> {
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
      agentId: "agent-prod-openclaw",
      delegationId: "delegation-prod-openclaw",
      sessionId: "session-prod-openclaw",
      sessionExpiresAt: "2030-01-01T00:00:00.000Z",
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const payload = JSON.parse(text) as {
    value: { session: { token: string } };
  };
  return payload.value.session.token;
}

async function writeNote(client: TeamMemoryHttpClient, suffix: string): Promise<void> {
  await client.write({
    clientMutationId: `prod-write-${suffix}`,
    target: {
      kind: "memory_entity",
      name: `Production ${suffix}`,
    },
    patch: {
      title: `Production ${suffix}`,
      description: "Direct host memory works",
      tags: ["production"],
    },
  });
}

function frame(payload: unknown): Buffer {
  const text = JSON.stringify(payload);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
}

function parseFrames(writes: string[]): unknown[] {
  return writes.map((write) => {
    const index = write.indexOf("\r\n\r\n");
    assert.notEqual(index, -1);
    return JSON.parse(write.slice(index + 4)) as unknown;
  });
}

async function waitForResponses(writes: string[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (writes.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`expected ${count} MCP responses, got ${writes.length}`);
}

test("production connector paths cover OpenClaw replacement memory and MCP stdio hosts without hanging", async () => {
  const fixture = await setup();
  try {
    const token = await onboard(fixture.baseUrl, fixture.admin.token);
    const client = new TeamMemoryHttpClient({
      baseUrl: fixture.baseUrl,
      token,
      fetch: connectorFetch,
    });
    const identity = await client.identity() as {
      agentId: string;
      rootEntityId: string;
      provider: {
        mode: string;
        trustedRootEntityId: string;
        visibleTools: string[];
        tokenAvailable: boolean;
      };
    };
    assert.equal(identity.agentId, "agent-prod-openclaw");
    assert.equal(identity.rootEntityId, "root-prod");
    assert.equal(identity.provider.mode, "runtime");
    assert.equal(identity.provider.trustedRootEntityId, "root-prod");
    assert.equal(identity.provider.tokenAvailable, true);
    assert.ok(identity.provider.visibleTools.includes("memory.write"));
    const tools = await client.listTools() as Array<{
      name: string;
      description: string;
      inputSchema: { required?: string[]; additionalProperties?: boolean };
    }>;
    assert.ok(tools.some((tool) => tool.name === "memory.catalog"));
    assert.ok(tools.some((tool) => tool.name === "memory.search"));
    assert.ok(tools.some((tool) => tool.name === "memory.write"));
    assert.ok(!tools.some((tool) => tool.name === "memory.importResource"));
    assert.ok(!tools.some((tool) => tool.name === "memory.ingestResource"));
    const writeTool = tools.find((tool) => tool.name === "memory.write");
    assert.equal(writeTool?.inputSchema.required, undefined);
    assert.equal(writeTool?.inputSchema.additionalProperties, false);
    assert.match(writeTool?.description ?? "", /operations\[\]/);
    assert.match(writeTool?.description ?? "", /contradicts/);
    assert.match(writeTool?.description ?? "", /top-level payload\.conflict/);
    assert.match(writeTool?.description ?? "", /raw transcript-as-memory/);

    const openclaw = new OpenClawTeamMemoryPlugin({
      baseUrl: fixture.baseUrl,
      token,
      mode: "team_memory_replaces_native",
      fetch: connectorFetch,
    });
    assert.deepEqual(
      openclaw.tools().map((tool) => tool.name),
      ["memory_search", "memory_catalog", "memory_write"],
    );
    const openclawWrite = openclaw.tools().find((tool) => tool.name === "memory_write");
    assert.match(openclawWrite?.description ?? "", /operations\[\]/);
    assert.match(openclawWrite?.description ?? "", /contradicts/);
    assert.match(openclawWrite?.description ?? "", /top-level payload\.conflict/);

    await openclaw.call("memory_write", {
      clientMutationId: "openclaw-write",
      target: {
        kind: "memory_entity",
        name: "OpenClaw Production Memory",
      },
      patch: {
        title: "OpenClaw Production Memory",
        description: "OpenClaw writes through stable capture",
        tags: ["openclaw"],
      },
    });
    const search = await openclaw.call("memory_search", {
      text: "OpenClaw Production",
    }) as { value: { items: unknown[] } };
    assert.equal(search.value.items.length, 1);

    const imported = await openclaw.call("memory_import", {
      clientMutationId: "openclaw-import-resource",
      resourceId: "resource-openclaw",
      title: "OpenClaw resource",
      sourceType: "document",
      content: "OpenClaw can import resources",
    }) as { resource: { id: string }; ingestion: { status: string } };
    assert.equal(imported.resource.id, "resource-openclaw");
    assert.ok(["indexed", "retryable_failed"].includes(imported.ingestion.status));
    const resource = await openclaw.call("memory_get", {
      resourceId: "resource-openclaw",
    }) as { resource: { id: string } };
    assert.equal(resource.resource.id, "resource-openclaw");

    await writeNote(client, "mcp");
    const writes: string[] = [];
    const mcp = new TeamMemoryMcpStdioServer(client, (payload) => writes.push(payload));
    mcp.receive(frame({ jsonrpc: "2.0", id: 1, method: "initialize" }));
    mcp.receive(frame({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    mcp.receive(frame({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "memory.search",
        arguments: { query: "Production mcp" },
      },
    }));
    await waitForResponses(writes, 3);
    const responses = parseFrames(writes) as Array<{
      id: number;
      result: Record<string, unknown>;
    }>;
    const byId = new Map(responses.map((response) => [response.id, response.result]));
    assert.equal((byId.get(1) as { serverInfo: { name: string } }).serverInfo.name, "team-memory-rbac");
    assert.ok((byId.get(2) as { tools: Array<{ name: string }> }).tools.some((tool) => tool.name === "memory.search"));
    const content = (byId.get(3) as { content: Array<{ text: string }> }).content[0]?.text;
    assert.ok(JSON.parse(content ?? "{}").value.items.length >= 1);
  } finally {
    await close(fixture);
  }
});
