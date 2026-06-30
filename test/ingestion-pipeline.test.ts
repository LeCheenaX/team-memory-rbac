import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AuthenticatedSession } from "../adapters/libsql/rbac-authority.ts";
import { createLibsqlClient } from "../adapters/libsql/client.ts";
import { LibsqlBm25Index } from "../adapters/libsql/bm25-index.ts";
import type {
  PermissionDecision,
  PermissionRequest,
  PolicyEngine,
} from "../src/contracts/rbac.ts";
import { contentHash } from "../adapters/cas/filesystem.ts";
import {
  InMemoryBm25Index,
  InMemoryCloudMemoryAuthority,
  InMemoryMemoryRelationStore,
  InMemoryResourceCas,
  InMemoryVectorMemoryStore,
  MemoryRetrievalAdapter,
  PermissionRouter,
  ResourceIngestionService,
  ResourceService,
  StoreBackedAuthorizedQuerySource,
  type EmbeddingProvider,
  type ResourceSourceType,
} from "../src/index.ts";

const rootEntityId = "root:ingestion";
const timestamp = "2026-06-30T00:00:00.000Z";

function decision(request: PermissionRequest): PermissionDecision {
  return {
    allowed: true,
    reason: "allowed",
    subjectId: "user:alice",
    subjectKind: "user",
    rootEntityId: request.rootEntityId,
    action: request.action,
    resourceKind: request.resourceKind,
    matchedRoles: ["role:maintainer"],
    missingActions: [],
    constraints: {},
  };
}

const policy: PolicyEngine = {
  decide: async (request) => decision(request),
};

const session: AuthenticatedSession = {
  sessionId: "session:alice",
  userId: "user:alice",
  rootEntityId,
  taskScope: { rootEntityId, allowedResourceIds: ["resource:doc"] },
  subject: { kind: "user", userId: "user:alice" },
};

async function setup() {
  const history = new InMemoryCloudMemoryAuthority();
  await history.execute({
    subject: session.subject,
    rootEntityId,
    branchRef: "main",
    action: "create_root_entity",
    resourceKind: "memory_entity",
    clientMutationId: "create-root",
    commit: { id: "commit:create-root" },
    operation: {
      kind: "create_entity",
      id: "operation:create-root",
      entity: {
        id: rootEntityId,
        rootEntityId: null,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
    authorization: {
      ...decision({
        subject: session.subject,
        rootEntityId,
        action: "create_root_entity",
        resourceKind: "memory_entity",
      }),
      allowed: true,
    },
  });
  const cas = new InMemoryResourceCas();
  const resources = new ResourceService(policy, history, cas, () => timestamp);
  const vectors = new InMemoryVectorMemoryStore();
  const bm25 = new InMemoryBm25Index();
  const relations = new InMemoryMemoryRelationStore();
  const ingestion = new ResourceIngestionService(
    policy,
    history,
    cas,
    vectors,
    bm25,
    undefined,
    () => timestamp,
  );
  const retrieval = new PermissionRouter(
    policy,
    new MemoryRetrievalAdapter(
      new StoreBackedAuthorizedQuerySource(
        vectors,
        relations,
        "cloud_active",
        bm25,
      ),
    ),
  );
  return { history, resources, ingestion, retrieval, vectors, cas };
}

test("resource ingestion chunks document content, indexes BM25 and vectors, and reruns idempotently", async () => {
  const { history, resources, ingestion, retrieval } = await setup();
  await resources.import(session, {
    clientMutationId: "import-doc",
    resourceId: "resource:doc",
    revisionId: "revision:doc:v1",
    title: "Deployment guide",
    sourceType: "document",
    content: "Deploy the application safely.\n\nRollback steps stay nearby.",
  });

  const first = await ingestion.ingest(session, {
    resourceId: "resource:doc",
    clientMutationId: "ingest-doc",
    maxChunkCharacters: 32,
  });
  assert.equal(first.revisionId, "revision:doc:v1");
  assert.ok(first.chunks.length >= 2);
  assert.equal(first.chunks[0]?.contentHash, contentHash(first.chunks[0]?.text ?? ""));
  assert.equal(first.chunks[0]?.metadata?.revisionId, "revision:doc:v1");
  const commitCount = history.listCommitRecords(rootEntityId, "main").length;

  const keyword = await retrieval.execute({
    subject: session.subject,
    rootEntityId,
    branchRef: "main",
    action: "search",
    resourceKind: "resource_chunk",
    taskScope: session.taskScope,
    query: { kind: "keyword", text: "rollback" },
  });
  if (!("value" in keyword)) assert.fail("expected keyword result");
  assert.equal(keyword.value.items[0]?.kind, "resource_chunk");

  const semantic = await retrieval.execute({
    subject: session.subject,
    rootEntityId,
    branchRef: "main",
    action: "search",
    resourceKind: "resource_chunk",
    taskScope: session.taskScope,
    query: { kind: "semantic", embedding: [1, 0, 0, 0], limit: 5 },
  });
  if (!("value" in semantic)) assert.fail("expected semantic result");
  assert.ok(
    semantic.value.items.some(
      (item) =>
        item.kind === "resource_chunk" &&
        item.chunk.resourceId === "resource:doc",
    ),
  );

  const second = await ingestion.ingest(session, {
    resourceId: "resource:doc",
    clientMutationId: "ingest-doc-rerun",
    maxChunkCharacters: 32,
  });
  assert.equal(second.rebuiltOnly, true);
  assert.equal(history.listCommitRecords(rootEntityId, "main").length, commitCount);
});

test("ingestion supports conversation, code_file, and tool_output chunk metadata", async () => {
  const { resources, ingestion } = await setup();
  const sourceTypes: ResourceSourceType[] = [
    "conversation",
    "code_file",
    "tool_output",
  ];
  for (const sourceType of sourceTypes) {
    const resourceId = `resource:${sourceType}`;
    const scopedSession = {
      ...session,
      taskScope: { rootEntityId, allowedResourceIds: [resourceId] },
    };
    await resources.import(scopedSession, {
      clientMutationId: `import-${sourceType}`,
      resourceId,
      revisionId: `revision:${sourceType}:v1`,
      title: sourceType,
      sourceType,
      content: "line one\nline two\nline three\nline four",
    });
    const result = await ingestion.ingest(scopedSession, {
      resourceId,
      clientMutationId: `ingest-${sourceType}`,
      maxChunkCharacters: 12,
    });
    assert.ok(result.chunks.length > 0);
    assert.equal(result.chunks[0]?.metadata?.revisionId, `revision:${sourceType}:v1`);
    assert.equal(result.chunks[0]?.metadata?.startLine, 1);
  }
});

test("failed ingestion can be retried without leaving searchable partial chunks", async () => {
  const { history, resources, vectors, cas } = await setup();
  await resources.import(session, {
    clientMutationId: "import-failing-doc",
    resourceId: "resource:doc",
    revisionId: "revision:failing:v1",
    title: "Failing guide",
    sourceType: "document",
    content: "first chunk\n\nsecond chunk",
  });
  const failingEmbeddings: EmbeddingProvider = {
    embed: async (text) => {
      if (text.includes("second")) {
        throw new Error("embedding backend unavailable");
      }
      return [1, 0];
    },
  };
  const ingestion = new ResourceIngestionService(
    policy,
    history,
    cas,
    vectors,
    new InMemoryBm25Index(),
    failingEmbeddings,
    () => timestamp,
  );

  await assert.rejects(
    ingestion.ingest(session, {
      resourceId: "resource:doc",
      clientMutationId: "ingest-failing",
      maxChunkCharacters: 8,
    }),
    /embedding backend unavailable/,
  );
  assert.equal(
    history.readActiveView(rootEntityId, "main").resourceChunks.length,
    0,
  );
  assert.deepEqual(
    await vectors.list({
      collection: "resource_chunks",
      filter: {
        rootEntityId,
        branchRef: "main",
        resourceId: "resource:doc",
        status: "active",
      },
    }),
    [],
  );
});

test("libSQL BM25 index replacement is durable and scoped", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "team-memory-bm25-"));
  const client = createLibsqlClient({ url: `file:${path.join(directory, "bm25.db")}` });
  try {
    const first = await LibsqlBm25Index.create(client);
    await first.replaceRevision({
      rootEntityId,
      branchRef: "main",
      resourceId: "resource:doc",
      revisionId: "revision:doc:v1",
      documents: [
        {
          id: "bm25:doc:0",
          rootEntityId,
          branchRef: "main",
          resourceId: "resource:doc",
          revisionId: "revision:doc:v1",
          chunkId: "chunk:doc:0",
          text: "rollback deploy guide",
          status: "active",
        },
      ],
    });
    const restarted = await LibsqlBm25Index.create(client);
    assert.equal(
      (await restarted.search({
        rootEntityId,
        branchRef: "main",
        text: "rollback",
        allowedResourceIds: ["resource:doc"],
      }))[0]?.document.chunkId,
      "chunk:doc:0",
    );
    assert.deepEqual(
      await restarted.search({
        rootEntityId,
        branchRef: "main",
        text: "rollback",
        allowedResourceIds: ["resource:other"],
      }),
      [],
    );
  } finally {
    client.close();
  }
});
