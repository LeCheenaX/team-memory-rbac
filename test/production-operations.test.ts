import assert from "node:assert/strict";
import test from "node:test";

import {
  FixedWindowRateLimiter,
  StructuredOperationalLogger,
  assertPayloadLimit,
  loadDeploymentSecrets,
  recoveryDrills,
  redactSecrets,
  requiredCiChecks,
  retry,
  withTimeout,
} from "../src/adapters/runtime/operations.ts";

test("operational config loads secrets from environment-shaped sources and redacts logs", () => {
  const secrets = loadDeploymentSecrets({
    get: (name) => name === "LIBSQL_AUTH_TOKEN" ? "secret-token" : undefined,
  });
  assert.deepEqual(secrets, { libsqlAuthToken: "secret-token" });
  assert.deepEqual(redactSecrets({ token: "abc", nested: { apiKey: "def", value: 1 } }), {
    token: "[redacted]",
    nested: { apiKey: "[redacted]", value: 1 },
  });
  const records: unknown[] = [];
  new StructuredOperationalLogger((record) => records.push(record)).emit({
    level: "info",
    event: "memory.write",
    traceId: "trace-1",
    auditId: "audit-1",
    metrics: { durationMs: 12 },
    details: { password: "hidden" },
  });
  assert.equal(JSON.stringify(records).includes("hidden"), false);
  assert.equal(JSON.stringify(records).includes("trace-1"), true);
});

test("service guardrails cover rate limits, payload limits, timeouts, retries, recovery, and CI checks", async () => {
  let now = 0;
  const limiter = new FixedWindowRateLimiter(2, 1000, () => now);
  assert.equal(limiter.check("session").allowed, true);
  assert.equal(limiter.check("session").allowed, true);
  assert.equal(limiter.check("session").allowed, false);
  now = 1000;
  assert.equal(limiter.check("session").allowed, true);
  assert.throws(() => assertPayloadLimit("abcd", 3), /payload exceeds/);
  await assert.rejects(
    () => withTimeout(new Promise((resolve) => setTimeout(resolve, 20)), 1),
    /timed out/,
  );
  let attempts = 0;
  assert.equal(
    await retry(async () => {
      attempts += 1;
      if (attempts < 2) throw new Error("transient");
      return "ok";
    }, { attempts: 2, delayMs: 0 }),
    "ok",
  );
  assert.deepEqual(recoveryDrills().map((drill) => drill.dependency), [
    "cas",
    "libsql",
    "qdrant",
  ]);
  assert.ok(requiredCiChecks().includes("npm run migrations:validate"));
  assert.ok(requiredCiChecks().includes("npm run smoke:dev"));
});
