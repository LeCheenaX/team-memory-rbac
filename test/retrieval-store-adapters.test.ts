import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { createLibsqlClient } from "../src/adapters/libsql/client.ts";
import { LibsqlMemoryRelationStore } from "../src/adapters/libsql/relation-store.ts";
import { QdrantVectorMemoryStore } from "../src/adapters/qdrant/vector-memory-store.ts";
import type {
  MemoryEntity,
  MemoryEntityBranch,
  MemoryRelation,
  ResourceChunk,
} from "../src/contracts/memory.ts";
import type {
  PermissionDecision,
  PermissionRequest,
  PolicyEngine,
} from "../src/contracts/rbac.ts";
import {
  MemoryRetrievalAdapter,
  type MemoryRetrievalRequest,
  StoreBackedAuthorizedQuerySource,
} from "../src/memory/retrieval.ts";
import { PermissionRouter } from "../src/permission-router.ts";
import { unitTestEmbeddingProvider } from "./support/runtime-config.ts";

const timestamp = "2026-06-30T00:00:00.000Z";
const rootEntityId = "root:retrieval";

interface FakeQdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

async function json(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length === 0 ? {} : JSON.parse(raw) as Record<string, unknown>;
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function dotProduct(left: number[], right: number[]): number {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

function conditionMatches(
  payload: Record<string, unknown>,
  condition: Record<string, unknown>,
): boolean {
  const key = condition.key;
  const match = condition.match as Record<string, unknown> | undefined;
  if (typeof key !== "string" || match === undefined) {
    return true;
  }
  const value = payload[key];
  if ("value" in match) {
    return Array.isArray(value)
      ? value.includes(match.value)
      : value === match.value;
  }
  if (Array.isArray(match.any)) {
    return match.any.includes(value);
  }
  return true;
}

function filterMatches(
  payload: Record<string, unknown>,
  filter: Record<string, unknown> | undefined,
): boolean {
  const must = Array.isArray(filter?.must) ? filter.must : [];
  const mustNot = Array.isArray(filter?.must_not) ? filter.must_not : [];
  const should = Array.isArray(filter?.should) ? filter.should : [];
  return (
    must.every((condition) =>
      conditionMatches(payload, condition as Record<string, unknown>),
    ) &&
    !mustNot.some((condition) =>
      conditionMatches(payload, condition as Record<string, unknown>),
    ) &&
    (should.length === 0 ||
      should.some((condition) =>
        conditionMatches(payload, condition as Record<string, unknown>),
      ))
  );
}

async function createFakeQdrant() {
  const collections = new Map<string, Map<string, FakeQdrantPoint>>();
  const vectorSizes = new Map<string, number>();
  const filters: Array<{ collection: string; filter: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = /^\/collections\/([^/]+)(?:\/points(?:\/([^/]+))?)?$/.exec(url.pathname);
    if (match?.[1] === undefined) {
      return send(response, 404, { status: { error: "not found" } });
    }
    const collection = decodeURIComponent(match[1]);
    const action = match[2];
    const isPointsRoot = url.pathname.endsWith("/points");
    if (request.method === "GET" && action === undefined) {
      return collections.has(collection)
        ? send(response, 200, {
            result: {
              status: "green",
              config: {
                params: {
                  vectors: {
                    size: vectorSizes.get(collection),
                    distance: "Cosine",
                  },
                },
              },
            },
          })
        : send(response, 404, { status: { error: "not found" } });
    }
    if (request.method === "PUT" && action === undefined && !isPointsRoot) {
      const payload = await json(request);
      const size = (payload.vectors as { size?: unknown } | undefined)?.size;
      if (typeof size !== "number") {
        return send(response, 400, { status: { error: "missing vector size" } });
      }
      collections.set(collection, collections.get(collection) ?? new Map());
      vectorSizes.set(collection, size);
      return send(response, 200, { result: true });
    }
    if (request.method === "DELETE" && action === undefined && !isPointsRoot) {
      collections.delete(collection);
      vectorSizes.delete(collection);
      return send(response, 200, { result: true });
    }
    const points = collections.get(collection);
    if (points === undefined) {
      return send(response, 404, { status: { error: "not found" } });
    }
    const payload = await json(request);
    if (request.method === "PUT" && isPointsRoot) {
      for (const point of payload.points as FakeQdrantPoint[]) {
        if (point.vector.length !== vectorSizes.get(collection)) {
          return send(response, 400, {
            status: {
              error: `Vector dimension error: expected dim: ${vectorSizes.get(collection)}, got ${point.vector.length}`,
            },
          });
        }
        points.set(point.id, point);
      }
      return send(response, 200, { result: { operation_id: 1 } });
    }
    if (request.method === "POST" && isPointsRoot) {
      const ids = payload.ids as string[];
      return send(response, 200, {
        result: ids.map((id) => points.get(id)).filter(Boolean),
      });
    }
    if (request.method === "POST" && action === "search") {
      const filter = payload.filter as Record<string, unknown>;
      filters.push({ collection, filter });
      const vector = payload.vector as number[];
      const limit = typeof payload.limit === "number" ? payload.limit : 20;
      const result = [...points.values()]
        .filter((point) => filterMatches(point.payload, filter))
        .map((point) => ({
          ...point,
          score: dotProduct(point.vector, vector),
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
      return send(response, 200, { result });
    }
    if (request.method === "POST" && action === "scroll") {
      const filter = payload.filter as Record<string, unknown>;
      filters.push({ collection, filter });
      const limit = typeof payload.limit === "number" ? payload.limit : 100;
      return send(response, 200, {
        result: {
          points: [...points.values()]
            .filter((point) => filterMatches(point.payload, filter))
            .slice(0, limit),
        },
      });
    }
    return send(response, 404, { status: { error: "not found" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(typeof address === "object" && address !== null);
  return {
    url: `http://127.0.0.1:${address.port}`,
    filters,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function decision(request: PermissionRequest): PermissionDecision {
  return {
    allowed: true,
    reason: "allowed",
    subjectId: "user:alice",
    subjectKind: "user",
    rootEntityId: request.rootEntityId,
    action: request.action,
    resourceKind: request.resourceKind,
    matchedRoles: ["role:researcher"],
    missingActions: [],
    constraints: {},
  };
}

const policy: PolicyEngine = {
  decide: async (request) => decision(request),
};

function retrievalRequest(query: MemoryRetrievalRequest["query"]) {
  return {
    subject: { kind: "user" as const, userId: "user:alice" },
    rootEntityId,
    branchRef: "main",
    action: "search" as const,
    resourceKind: "memory_entity" as const,
    taskScope: {
      rootEntityId,
      allowedTags: ["public"],
      allowedResourceIds: ["resource:runbook"],
      relationExpansionPolicy: {
        allowedRelationTypes: ["has", "refers_to"] as const,
        maxDepth: 1,
      },
    },
    query,
  };
}

test("Qdrant payloads and libSQL relations power authorized retrieval after restart", async () => {
  const qdrant = await createFakeQdrant();
  const directory = await mkdtemp(path.join(tmpdir(), "team-memory-retrieval-"));
  const client = createLibsqlClient({ url: `file:${path.join(directory, "memory.db")}` });
  try {
    const vectors = new QdrantVectorMemoryStore({ url: qdrant.url });
    const relations = await LibsqlMemoryRelationStore.create(client);
    const entity: MemoryEntity = {
      id: "entity:workflow",
      rootEntityId,
      currentBranchId: "branch:workflow",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const branch: MemoryEntityBranch = {
      id: "branch:workflow",
      entityId: entity.id,
      rootEntityId,
      branchRef: "main",
      title: "Release workflow",
      description: "Public deployment steps",
      tags: ["public", "workflow"],
      importance: 1,
      confidence: 1,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const secretBranch: MemoryEntityBranch = {
      ...branch,
      id: "branch:secret",
      entityId: "entity:secret",
      title: "Secret workflow",
      tags: ["secret"],
    };
    const chunk: ResourceChunk = {
      id: "chunk:evidence",
      rootEntityId,
      resourceId: "resource:runbook",
      chunkIndex: 0,
      text: "Release workflow evidence",
      contentHash: "sha256:evidence",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const relation: MemoryRelation = {
      id: "relation:evidence",
      rootEntityId,
      branchRef: "main",
      sourceId: entity.id,
      sourceKind: "memory_entity",
      targetId: chunk.id,
      targetKind: "resource_chunk",
      relationType: "refers_to",
      weight: 1,
      confidence: 1,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await vectors.upsert({
      collection: "memory_entities",
      id: entity.id,
      vector: [1, 0],
      payload: entity,
    });
    await vectors.upsert({
      collection: "memory_entity_branches",
      id: branch.id,
      vector: [1, 0],
      payload: branch,
    });
    await vectors.upsert({
      collection: "memory_entity_branches",
      id: secretBranch.id,
      vector: [0, 1],
      payload: secretBranch,
    });
    await vectors.upsert({
      collection: "resource_chunks",
      id: chunk.id,
      vector: [1, 0],
      payload: { ...chunk, branchRef: "main" },
    });
    await relations.upsert(relation);

    const restartedVectors = new QdrantVectorMemoryStore({ url: qdrant.url });
    const restartedRelations = await LibsqlMemoryRelationStore.create(client);
    const router = new PermissionRouter(
      policy,
      new MemoryRetrievalAdapter(
        new StoreBackedAuthorizedQuerySource(
          restartedVectors,
          restartedRelations,
        ),
        { embeddings: unitTestEmbeddingProvider() },
      ),
    );

    const semantic = await router.execute(
      retrievalRequest({ kind: "semantic", embedding: [1, 0] }),
    );
    assert.equal(semantic.decision.allowed, true);
    if (!("value" in semantic)) assert.fail("expected semantic result");
    const entityResult = semantic.value.items.find(
      (item) => item.kind === "entity",
    );
    assert.equal(entityResult?.kind === "entity" ? entityResult.entity.id : undefined, entity.id);
    assert.equal(entityResult?.kind === "entity" ? entityResult.evidence[0]?.id : undefined, chunk.id);
    assert.equal(
      semantic.value.items.some(
        (item) =>
          item.kind === "entity" && item.branch?.id === secretBranch.id,
      ),
      false,
    );

    const expanded = await router.execute(
      retrievalRequest({
        kind: "relations",
        startEntityId: entity.id,
        relationTypes: ["refers_to", "next_is"],
        maxDepth: 3,
      }),
    );
    if (!("value" in expanded)) assert.fail("expected relation result");
    assert.deepEqual(
      expanded.value.items.map((item) =>
        item.kind === "relation" ? item.relation.id : item.kind,
      ),
      [relation.id],
    );

    const rawBranch = await restartedVectors.get(
      "memory_entity_branches",
      branch.id,
    );
    assert.equal(rawBranch?.payload.rootEntityId, rootEntityId);
    assert.equal(rawBranch?.payload.branchRef, "main");
    assert.equal(rawBranch?.payload.status, "active");
    assert.equal(rawBranch?.payload.entityBranchId, branch.id);
    assert.equal((await restartedRelations.get(relation.id))?.targetId, chunk.id);
    assert.ok(
      qdrant.filters.some(
        ({ filter }) =>
          JSON.stringify(filter).includes(rootEntityId) &&
          JSON.stringify(filter).includes("active") &&
          JSON.stringify(filter).includes("public"),
      ),
      "expected root/status/TaskScope filters before Qdrant calls",
    );
  } finally {
    client.close();
    await qdrant.close();
  }
});

test("Qdrant adapter rebuilds stale vector-size collections before upsert", async () => {
  const qdrant = await createFakeQdrant();
  try {
    await new QdrantVectorMemoryStore({ url: qdrant.url }).upsert({
      collection: "memory_entities",
      id: "entity-old",
      vector: [1, 0],
      payload: {
        rootEntityId: "root-qdrant",
        entityId: "entity-old",
      },
    });

    const restarted = new QdrantVectorMemoryStore({ url: qdrant.url });
    await restarted.upsert({
      collection: "memory_entities",
      id: "entity-new",
      vector: [1, 0, 0],
      payload: {
        rootEntityId: "root-qdrant",
        entityId: "entity-new",
      },
    });

    assert.equal(
      (await restarted.get("memory_entities", "entity-new"))?.id,
      "entity-new",
    );
    assert.equal(await restarted.get("memory_entities", "entity-old"), undefined);
  } finally {
    await qdrant.close();
  }
});
