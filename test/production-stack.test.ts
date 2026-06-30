import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileSystemResourceCas, contentHash } from "../adapters/cas/filesystem.ts";
import { LibsqlHistoryAuthority } from "../adapters/libsql/history-authority.ts";
import { LibsqlRbacAuthority } from "../adapters/libsql/rbac-authority.ts";
import { createLibsqlClient } from "../adapters/libsql/client.ts";
import { bootstrapDevelopment, TeamMemoryRuntime } from "../adapters/runtime/development-stack.ts";
import { createTeamMemoryServer } from "../adapters/http/server.ts";
import { ScopedPolicyEngine } from "../src/rbac/policy-engine.ts";
import { ResourceNotFoundError } from "../src/resources/service.ts";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "team-memory-rbac-"));
}

async function removeTemporary(directory: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function allowedRootWrite(rootEntityId: string) {
  return {
    subject: { kind: "user" as const, userId: "user-admin" },
    rootEntityId,
    branchRef: "main",
    action: "create_root_entity" as const,
    resourceKind: "memory_entity" as const,
    clientMutationId: "mutation-root",
    commit: { id: "commit-root" },
    operation: {
      kind: "create_entity" as const,
      id: "operation-root",
      entity: { id: rootEntityId, rootEntityId: null, status: "active" as const, createdAt: "2026-06-26T00:00:00.000Z", updatedAt: "2026-06-26T00:00:00.000Z" },
    },
    authorization: {
      allowed: true as const,
      reason: "test",
      subjectId: "user-admin",
      subjectKind: "user" as const,
      rootEntityId,
      action: "create_root_entity" as const,
      resourceKind: "memory_entity" as const,
      matchedRoles: ["role-root-admin"],
      missingActions: [],
      constraints: { allowRootEntityMutation: true },
    },
  };
}

test("libSQL authorities survive restart and revoked delegations invalidate sessions", async () => {
  const directory = await temporaryDirectory();
  const url = `file:${join(directory, "team-memory.db")}`;
  const client = createLibsqlClient({ url });
  try {
    const rbac = await LibsqlRbacAuthority.create(client);
    await rbac.saveUser({ id: "user-1", displayName: "User", status: "active", createdAt: "2026-06-26T00:00:00.000Z", updatedAt: "2026-06-26T00:00:00.000Z" });
    await rbac.saveAgent({ id: "agent-1", ownerUserId: "user-1", agentType: "sub_agent", displayName: "Agent", status: "active", createdAt: "2026-06-26T00:00:00.000Z", updatedAt: "2026-06-26T00:00:00.000Z" });
    await rbac.saveDelegation({ id: "delegation-1", agentId: "agent-1", ownerUserId: "user-1", rootEntityId: "root-1", permissions: [{ action: "read", resourceKind: "resource" }], delegatedBy: "user-1", delegatedAt: "2026-06-26T00:00:00.000Z", status: "active" });
    const session = await rbac.createSession({ id: "session-1", userId: "user-1", agentId: "agent-1", delegationId: "delegation-1", rootEntityId: "root-1", taskScope: { rootEntityId: "root-1" }, expiresAt: "2030-01-01T00:00:00.000Z", createdAt: "2026-06-26T00:00:00.000Z" });
    assert.equal((await rbac.authenticate(session.token))?.subject.kind, "agent");
    client.close();

    const restartedClient = createLibsqlClient({ url });
    const restarted = await LibsqlRbacAuthority.create(restartedClient);
    assert.equal((await restarted.getUser("user-1"))?.displayName, "User");
    assert.equal((await restarted.authenticate(session.token))?.rootEntityId, "root-1");
    await restarted.revokeDelegation("delegation-1", "2026-06-26T01:00:00.000Z");
    assert.equal(await restarted.authenticate(session.token), undefined);
    restartedClient.close();
  } finally { /* libSQL closes its file handle asynchronously on Windows. */ }
});

test("libSQL History replays durable commits and keeps client mutations idempotent", async () => {
  const directory = await temporaryDirectory();
  const url = `file:${join(directory, "history.db")}`;
  const client = createLibsqlClient({ url });
  try {
    const history = await LibsqlHistoryAuthority.create(client);
    const request = allowedRootWrite("root-history");
    const first = await history.execute(request);
    const repeated = await history.execute(request);
    assert.equal(first.status, "accepted");
    assert.deepEqual(repeated, first);
    assert.equal(history.commitWatermark(), 1);
    client.close();

    const restartedClient = createLibsqlClient({ url });
    const restarted = await LibsqlHistoryAuthority.create(restartedClient);
    assert.equal(restarted.headCommitId("root-history", "main"), "commit-root");
    assert.equal((await restarted.replay({ rootEntityId: "root-history", branchRef: "main" })).length, 1);
    restartedClient.close();
  } finally { /* libSQL closes its file handle asynchronously on Windows. */ }
});

test("authorized CAS imports preserve revisions and do not reveal tombstoned resources", async () => {
  const directory = await temporaryDirectory();
  const config = {
    libsqlUrl: `file:${join(directory, "runtime.db")}`,
    casDirectory: join(directory, "cas"),
    qdrantUrl: "http://127.0.0.1:6333",
    objectStoreUrl: "http://127.0.0.1:9000",
  };
  const now = "2026-06-26T00:00:00.000Z";
  const runtime = await TeamMemoryRuntime.create(config);
  try {
    const created = await bootstrapDevelopment(runtime, { rootEntityId: "root-resources", userId: "user-resource", displayName: "Resource User", sessionId: "session-resource", sessionExpiresAt: "2030-01-01T00:00:00.000Z", now });
    const session = await runtime.rbac.authenticate(created.token);
    assert.ok(session !== undefined);
    if (session === undefined) return;
    const imported = await runtime.resources.import(session, { clientMutationId: "import-v1", resourceId: "resource-1", revisionId: "revision-1", title: "Notes", sourceType: "document", content: "version one" });
    assert.equal(imported.contentHash, contentHash("version one"));
    await runtime.resources.revise(session, { clientMutationId: "import-v2", resourceId: "resource-1", revisionId: "revision-2", content: "version two" });
    assert.equal(Buffer.from((await runtime.resources.read(session, { resourceId: "resource-1", revisionId: "revision-1" })).content).toString(), "version one");
    assert.equal(Buffer.from((await runtime.resources.read(session, { resourceId: "resource-1" })).content).toString(), "version two");
    await runtime.resources.tombstone(session, { clientMutationId: "delete-v1", resourceId: "resource-1" });
    await assert.rejects(() => runtime.resources.read(session, { resourceId: "resource-1" }), ResourceNotFoundError);
  } finally { runtime.close(); }
});

test("CAS rejects a claimed hash that does not match its bytes", async () => {
  const directory = await temporaryDirectory();
  try {
    const cas = new FileSystemResourceCas(directory);
    await assert.rejects(() => cas.put({ contentHash: contentHash("expected"), content: "different" }), /hash does not match/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("HTTP smoke flow bootstraps, imports, and reads through a trusted session", async () => {
  const directory = await temporaryDirectory();
  const runtime = await TeamMemoryRuntime.create({ libsqlUrl: `file:${join(directory, "http.db")}`, casDirectory: join(directory, "cas"), qdrantUrl: "http://127.0.0.1:6333", objectStoreUrl: "http://127.0.0.1:9000" });
  const server = createTeamMemoryServer(runtime);
  try {
    const session = await bootstrapDevelopment(runtime, { rootEntityId: "root-http", userId: "user-http", displayName: "HTTP User", sessionId: "session-http", sessionExpiresAt: "2030-01-01T00:00:00.000Z", now: "2026-06-26T00:00:00.000Z" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    if (address === null || typeof address === "string") return;
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/live`)).status, 200);
    const rootCreated = await fetch(`${base}/admin/roots`, { method: "POST", headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" }, body: JSON.stringify({ clientMutationId: "http-root", rootEntityId: "root-created-over-http" }) });
    assert.equal(rootCreated.status, 201, await rootCreated.text());
    assert.equal(runtime.history.readActiveView("root-created-over-http", "main").entities[0]?.rootEntityId, null);
    const imported = await fetch(`${base}/resources/import`, { method: "POST", headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" }, body: JSON.stringify({ clientMutationId: "http-import", resourceId: "resource-http", title: "HTTP document", sourceType: "document", content: "hello from HTTP" }) });
    assert.equal(imported.status, 201);
    assert.equal((await fetch(`${base}/resources/resource-http`)).status, 401);
    const read = await fetch(`${base}/resources/resource-http`, { headers: { authorization: `Bearer ${session.token}` } });
    assert.equal(read.status, 200);
    assert.equal(Buffer.from((await read.json() as { contentBase64: string }).contentBase64, "base64").toString(), "hello from HTTP");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close();
  }
});
