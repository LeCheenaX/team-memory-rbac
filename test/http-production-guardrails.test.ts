import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import test from "node:test";

import {
  createTeamMemoryServer,
  type TeamMemoryHttpServerOptions,
} from "../src/adapters/http/server.ts";
import { StructuredOperationalLogger } from "../src/adapters/runtime/operations.ts";

function gateway(overrides: Record<string, unknown> = {}) {
  const ok = async () => ({ ok: true });
  return {
    identity: ok,
    listAgentTools: ok,
    listRoots: ok,
    createRoot: ok,
    listMembers: ok,
    assignRole: ok,
    revokeRole: ok,
    listDelegations: ok,
    createDelegation: ok,
    revokeDelegation: ok,
    onboardAgent: ok,
    importResource: ok,
    reviseResource: ok,
    readResource: ok,
    writeMemory: ok,
    searchMemory: ok,
    listHistory: ok,
    listConflicts: ok,
    resolveConflict: ok,
    pullSync: ok,
    syncStatus: ok,
    ...overrides,
  };
}

async function listen(
  options: TeamMemoryHttpServerOptions,
  overrides: Record<string, unknown> = {},
): Promise<{ baseUrl: string; server: Server }> {
  const server = createTeamMemoryServer(gateway(overrides), options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  server.closeIdleConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("HTTP production guardrails reject oversized bodies, timed-out handlers, and rate-limited tokens", async () => {
  const records: unknown[] = [];
  const logger = new StructuredOperationalLogger((record) => records.push(record));
  const fixture = await listen(
    {
      requestBodyLimitBytes: 32,
      requestTimeoutMs: 25,
      rateLimit: { maxRequests: 2, windowMs: 1_000 },
      logger,
      traceId: () => "trace-guardrail",
    },
    {
      searchMemory: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { value: { items: [] } };
      },
    },
  );
  try {
    const oversized = await fetch(`${fixture.baseUrl}/resources/import`, {
      method: "POST",
      headers: {
        authorization: "Bearer token-secret",
        "content-type": "application/json",
        "x-audit-id": "audit-1",
      },
      body: JSON.stringify({ content: "this payload is intentionally too large" }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.headers.get("x-trace-id"), "trace-guardrail");
    assert.equal(((await oversized.json()) as { error: { code: string } }).error.code, "request_too_large");

    const timeout = await fetch(`${fixture.baseUrl}/memory/search`, {
      method: "POST",
      headers: {
        authorization: "Bearer other-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(timeout.status, 504);

    assert.equal((await fetch(`${fixture.baseUrl}/identity`, { headers: { authorization: "Bearer rate-token" } })).status, 200);
    assert.equal((await fetch(`${fixture.baseUrl}/identity`, { headers: { authorization: "Bearer rate-token" } })).status, 200);
    const limited = await fetch(`${fixture.baseUrl}/identity`, { headers: { authorization: "Bearer rate-token" } });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.has("retry-after"), true);

    const serialized = JSON.stringify(records);
    assert.match(serialized, /"method":"POST"/);
    assert.match(serialized, /"route":"\/resources\/import"/);
    assert.match(serialized, /"status":413/);
    assert.match(serialized, /trace-guardrail/);
    assert.match(serialized, /audit-1/);
    assert.equal(serialized.includes("token-secret"), false);
  } finally {
    await close(fixture.server);
  }
});
