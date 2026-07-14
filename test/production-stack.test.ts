import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileSystemResourceCas, contentHash } from "../src/adapters/cas/filesystem.ts";
import { ObjectStoreResourceCas } from "../src/adapters/cas/object-store.ts";
import { LibsqlHistoryAuthority } from "../src/adapters/libsql/history-authority.ts";
import { LibsqlRbacAuthority } from "../src/adapters/libsql/rbac-authority.ts";
import { createLibsqlClient } from "../src/adapters/libsql/client.ts";
import { bootstrapDevelopment, loadRuntimeConfig, TeamMemoryRuntime } from "../src/adapters/runtime/development-stack.ts";
import { createTeamMemoryServer } from "../src/adapters/http/server.ts";
import { TeamMemoryGateway } from "../src/adapters/runtime/gateway.ts";
import { ResourceConflictError, ResourceNotFoundError, ResourceService } from "../src/resources/service.ts";
import {
  unitTestRuntimeConfig,
} from "./support/runtime-config.ts";
import {
  AuthorizedWorkingReplicaSynchronizer,
  CloudAuthorizedViewAdapter,
  InMemoryLocalAuthorizedWorkingReplica,
  PermissionRouter,
  SynchronizedLocalQuerySource,
  InMemoryCloudMemoryAuthority,
  type PermissionDecision,
  type PermissionRequest,
  type PolicyEngine,
} from "../src/index.ts";
import type { ResourceCas, ResourceCasObject } from "../src/memory/stores.ts";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "team-memory-rbac-"));
}

async function removeTemporary(directory: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 500));
  await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
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

async function readRequest(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function objectStoreFixture(): Promise<{ url: string; close(): Promise<void> }> {
  const objects = new Map<string, Buffer>();
  const server = createServer(async (request, response) => {
    if (request.url === "/minio/health/live") {
      response.writeHead(200).end("ok");
      return;
    }
    if (request.url?.startsWith("/cas/sha256/") !== true) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "PUT") {
      objects.set(request.url, await readRequest(request));
      response.writeHead(201).end();
      return;
    }
    if (request.method === "GET") {
      const object = objects.get(request.url);
      if (object === undefined) {
        response.writeHead(404).end();
      } else {
        response.writeHead(200).end(object);
      }
      return;
    }
    response.writeHead(405).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  if (address === null || typeof address === "string") throw new Error("server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

class AllowAllPolicy implements PolicyEngine {
  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    const subjectId = request.subject.kind === "user" ? request.subject.userId : request.subject.agentId;
    return { allowed: true, reason: "test", subjectId, subjectKind: request.subject.kind, rootEntityId: request.rootEntityId, action: request.action, resourceKind: request.resourceKind, matchedRoles: ["role-test"], missingActions: [], constraints: {} };
  }
}

class UnreadableCas implements ResourceCas {
  async put(_object: ResourceCasObject): Promise<void> {}
  async get(_contentHash: string): Promise<ResourceCasObject | undefined> { return undefined; }
  async remove(_contentHash: string): Promise<void> {}
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
  const config = unitTestRuntimeConfig({
    directory,
    databaseName: "runtime.db",
  });
  const now = "2026-06-26T00:00:00.000Z";
  const runtime = await TeamMemoryRuntime.create(config);
  try {
    const created = await bootstrapDevelopment(runtime, { rootEntityId: "root-resources", userId: "user-resource", displayName: "Resource User", sessionId: "session-resource", sessionExpiresAt: "2030-01-01T00:00:00.000Z", now });
    const session = await runtime.rbac.authenticate(created.token);
    assert.ok(session !== undefined);
    if (session === undefined) return;
    const imported = await runtime.resources.import(session, { clientMutationId: "import-v1", resourceId: "resource-1", revisionId: "revision-1", title: "Notes", sourceType: "document", content: "version one" });
    assert.equal(imported.contentHash, contentHash("version one"));
    const v1Head = runtime.history.headCommitId("root-resources", "main");
    await runtime.resources.revise(session, { clientMutationId: "import-v2", resourceId: "resource-1", revisionId: "revision-2", content: "version two" });
    await assert.rejects(
      () => runtime.resources.revise(session, {
        clientMutationId: "import-stale",
        resourceId: "resource-1",
        revisionId: "revision-stale",
        content: "stale version",
        expectedHeadCommitId: v1Head,
      }),
      ResourceConflictError,
    );
    assert.equal(Buffer.from((await runtime.resources.read(session, { resourceId: "resource-1", revisionId: "revision-1" })).content).toString(), "version one");
    assert.equal(Buffer.from((await runtime.resources.read(session, { resourceId: "resource-1" })).content).toString(), "version two");
    await runtime.resources.tombstone(session, { clientMutationId: "delete-v1", resourceId: "resource-1" });
    await assert.rejects(() => runtime.resources.read(session, { resourceId: "resource-1" }), ResourceNotFoundError);
  } finally { runtime.close(); }
});

test("production v1 architecture and CAS deployment modes are documented", async () => {
  const notes = await readFile("DESIGN-NOTES.md", "utf8");
  assert.match(notes, /one logical Cloud Authority/);
  assert.match(notes, /single service worker/);
  assert.match(notes, /same durable shared volume/);
  assert.match(notes, /object_store/);
  assert.match(notes, /CP distributed\s+systems/);
  assert.match(notes, /not an AP multi-master design/);

  assert.equal(loadRuntimeConfig({
    runtimeMode: "unitTest",
    libsql: { url: "file:prod.db" },
    cas: { backend: "filesystem", directory: "/var/cas" },
    qdrant: { url: "http://qdrant" },
    embedding: { provider: "deterministic", url: "deterministic://test" },
  }).casBackend, "filesystem");
  assert.equal(loadRuntimeConfig({
    runtimeMode: "unitTest",
    libsql: { url: "file:prod.db" },
    cas: { backend: "object_store", objectStoreUrl: "http://objects" },
    qdrant: { url: "http://qdrant" },
    embedding: { provider: "deterministic", url: "deterministic://test" },
  }).casBackend, "object_store");
  assert.throws(() => loadRuntimeConfig({
    runtimeMode: "unitTest",
    libsql: { url: "file:prod.db" },
    cas: { backend: "" as "filesystem" },
    qdrant: { url: "http://qdrant" },
    embedding: { provider: "deterministic", url: "deterministic://test" },
  }), /cas\.backend/);
});

test("CAS-first visibility blocks History commits when CAS is not durably readable", async () => {
  const history = new InMemoryCloudMemoryAuthority();
  const service = new ResourceService(new AllowAllPolicy(), history, new UnreadableCas());
  await assert.rejects(
    () => service.import({
      sessionId: "session-cas",
      userId: "user-cas",
      rootEntityId: "root-cas",
      taskScope: { rootEntityId: "root-cas" },
      subject: { kind: "user", userId: "user-cas" },
    }, {
      clientMutationId: "import-unreadable",
      resourceId: "resource-unreadable",
      title: "Unreadable",
      sourceType: "document",
      content: "not durable",
    }),
    /durably readable/,
  );
  assert.equal(history.commitWatermark(), 0);
  assert.equal(history.readActiveView("root-cas", "main").resources.length, 0);
});

test("a second service worker reads filesystem CAS content through a shared volume", async () => {
  const directory = await temporaryDirectory();
  try {
    const first = new FileSystemResourceCas(directory);
    const second = new FileSystemResourceCas(directory);
    const hash = contentHash("visible from worker two");
    await first.ready();
    await second.ready();
    await first.put({ contentHash: hash, content: "visible from worker two" });
    assert.equal(Buffer.from((await second.get(hash))?.content ?? "").toString(), "visible from worker two");
  } finally {
    await removeTemporary(directory);
  }
});

test("a second service worker reads object-store CAS content imported by the first", async () => {
  const objectStore = await objectStoreFixture();
  try {
    const first = new ObjectStoreResourceCas(objectStore.url);
    const second = new ObjectStoreResourceCas(objectStore.url);
    const hash = contentHash("visible through object store");
    await first.put({ contentHash: hash, content: "visible through object store" });
    assert.equal(Buffer.from((await second.get(hash))?.content ?? "").toString(), "visible through object store");
  } finally {
    await objectStore.close();
  }
});

test("CAS rejects a claimed hash that does not match its bytes", async () => {
  const directory = await temporaryDirectory();
  try {
    const cas = new FileSystemResourceCas(directory);
    await assert.rejects(() => cas.put({ contentHash: contentHash("expected"), content: "different" }), /hash does not match/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("gateway sync uses durable permission watermarks for role and delegation changes", async () => {
  const directory = await temporaryDirectory();
  const runtime = await TeamMemoryRuntime.create(unitTestRuntimeConfig({
    directory,
    databaseName: "watermarks.db",
  }));
  const gateway = new TeamMemoryGateway(runtime, { retrieval: "active-view" });
  try {
    const adminSession = await bootstrapDevelopment(runtime, { rootEntityId: "root-watermark", userId: "user-watermark", displayName: "Watermark Admin", sessionId: "session-watermark-admin", sessionExpiresAt: "2030-01-01T00:00:00.000Z", now: "2026-06-26T00:00:00.000Z" });
    const initial = await gateway.pullSync(adminSession.token, { branchRef: "main" });
    if (!("value" in initial)) assert.fail("expected sync");
    await gateway.assignRole(adminSession.token, { assignmentId: "assignment-watermark-extra", userId: "user-watermark", roleId: "role-researcher" });
    const changed = await gateway.pullSync(adminSession.token, {
      branchRef: "main",
      knownCommitWatermark: initial.value.identity.commitWatermark,
      knownPermissionWatermark: initial.value.identity.permissionWatermark,
      knownTaskScopeHash: initial.value.identity.taskScopeHash,
    });
    if (!("value" in changed)) assert.fail("expected sync");
    assert.equal(changed.value.kind, "replace");
    if (changed.value.kind !== "replace") assert.fail("expected replacement");
    assert.equal(changed.value.reason, "permission_changed");

    await runtime.rbac.saveAgent({ id: "agent-watermark", ownerUserId: "user-watermark", agentType: "sub_agent", displayName: "Watermark Agent", status: "active", createdAt: "2026-06-26T00:00:00.000Z", updatedAt: "2026-06-26T00:00:00.000Z" });
    await gateway.createDelegation(adminSession.token, { delegationId: "delegation-watermark", agentId: "agent-watermark", permissions: [{ action: "read", resourceKind: "memory_entity" }, { action: "search", resourceKind: "memory_entity" }] });
    const agentSession = await runtime.rbac.createSession({ id: "session-watermark-agent", userId: "user-watermark", agentId: "agent-watermark", delegationId: "delegation-watermark", rootEntityId: "root-watermark", taskScope: { rootEntityId: "root-watermark" }, expiresAt: "2030-01-01T00:00:00.000Z", createdAt: "2026-06-26T00:00:00.000Z" });
    const agent = await runtime.rbac.authenticate(agentSession.token);
    assert.ok(agent !== undefined);
    if (agent === undefined) return;
    const store = new InMemoryLocalAuthorizedWorkingReplica();
    await new AuthorizedWorkingReplicaSynchronizer(
      new PermissionRouter(runtime.policy, new CloudAuthorizedViewAdapter(runtime.history, runtime.rbac)),
      store,
    ).sync({ subject: agent.subject, rootEntityId: agent.rootEntityId, branchRef: "main", action: "read", resourceKind: "memory_entity", taskScope: agent.taskScope });
    const localQuery = new SynchronizedLocalQuerySource(store, runtime.rbac);
    assert.equal((await localQuery.entitySearch({ rootEntityId: "root-watermark", branchRef: "main", taskScope: agent.taskScope }, { entityIds: ["root-watermark"] }))[0]?.entity.id, "root-watermark");
    const beforeRevoke = await runtime.rbac.getPermissionWatermark("agent-watermark", "root-watermark");
    await gateway.revokeDelegation(adminSession.token, { delegationId: "delegation-watermark", agentId: "agent-watermark" });
    assert.notEqual(await runtime.rbac.getPermissionWatermark("agent-watermark", "root-watermark"), beforeRevoke);
    await assert.rejects(
      () => localQuery.entitySearch({ rootEntityId: "root-watermark", branchRef: "main", taskScope: agent.taskScope }, { entityIds: ["root-watermark"] }),
      /permission watermark changed/,
    );
    assert.equal(store.inspect().valid, false);
  } finally {
    runtime.close();
    await removeTemporary(directory);
  }
});

test("HTTP smoke flow bootstraps, imports, and reads through a trusted session", async () => {
  const directory = await temporaryDirectory();
  const runtime = await TeamMemoryRuntime.create(unitTestRuntimeConfig({
    directory,
    databaseName: "http.db",
  }));
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
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close();
  }
});
