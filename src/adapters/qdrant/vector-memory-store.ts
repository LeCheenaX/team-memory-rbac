import { createHash } from "node:crypto";
import type {
  MemoryVectorPayload,
  VectorMemoryCollection,
  VectorMemoryFilter,
  VectorMemoryPoint,
  VectorMemoryStore,
} from "../../memory/stores.ts";

export class QdrantUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QdrantUnavailableError";
  }
}

export interface QdrantVectorMemoryStoreOptions {
  url: string;
  apiKey?: string;
  distance?: "Cosine" | "Dot" | "Euclid" | "Manhattan";
}

type QdrantCondition = Record<string, unknown>;

function pointUuid(collection: VectorMemoryCollection, id: string): string {
  const hex = createHash("sha256")
    .update(`${collection}:${id}`)
    .digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function normalizeUrl(url: string): URL {
  return new URL(url.endsWith("/") ? url : `${url}/`);
}

function payloadFor(point: VectorMemoryPoint): MemoryVectorPayload {
  return {
    ...point.payload,
    memoryId: point.id,
    collection: point.collection,
    status: point.payload.status ?? "active",
    ...(point.collection === "resource_chunks"
      ? { chunkId: point.payload.chunkId ?? point.id }
      : {}),
    ...(point.collection === "memory_entity_branches"
      ? { entityBranchId: point.payload.entityBranchId ?? point.id }
      : {}),
    ...(point.collection === "memory_entities"
      ? { entityId: point.payload.entityId ?? point.id }
      : {}),
  };
}

function matchCondition(key: string, value: unknown): QdrantCondition {
  return { key, match: { value } };
}

function anyCondition(key: string, values: unknown[]): QdrantCondition {
  return { key, match: { any: values } };
}

function filterFor(input: VectorMemoryFilter): Record<string, unknown> {
  const must: QdrantCondition[] = [];
  const mustNot: QdrantCondition[] = [];
  const should: QdrantCondition[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (key === "tagsAny") {
      should.push(...(value as string[]).map((tag) => matchCondition("tags", tag)));
      continue;
    }
    if (key === "tagsNone") {
      mustNot.push(...(value as string[]).map((tag) => matchCondition("tags", tag)));
      continue;
    }
    must.push(
      Array.isArray(value)
        ? anyCondition(key, value)
        : matchCondition(key, value),
    );
  }
  return {
    ...(must.length === 0 ? {} : { must }),
    ...(mustNot.length === 0 ? {} : { must_not: mustNot }),
    ...(should.length === 0 ? {} : { should }),
  };
}

function appIdFromPayload(
  collection: VectorMemoryCollection,
  payload: Record<string, unknown>,
  fallback: string,
): string {
  const memoryId = payload.memoryId;
  if (typeof memoryId === "string") {
    return memoryId;
  }
  const key =
    collection === "resource_chunks"
      ? "chunkId"
      : collection === "memory_entity_branches"
        ? "entityBranchId"
        : "entityId";
  const value = payload[key];
  return typeof value === "string" ? value : fallback;
}

export class QdrantVectorMemoryStore implements VectorMemoryStore {
  private readonly baseUrl: URL;
  private readonly apiKey: string | undefined;
  private readonly distance: string;
  private readonly initialized = new Map<VectorMemoryCollection, number>();

  constructor(options: QdrantVectorMemoryStoreOptions) {
    this.baseUrl = normalizeUrl(options.url);
    this.apiKey = options.apiKey;
    this.distance = options.distance ?? "Cosine";
  }

  async upsert(point: VectorMemoryPoint): Promise<void> {
    await this.upsertMany([point]);
  }

  async upsertMany(points: VectorMemoryPoint[]): Promise<void> {
    const byCollection = new Map<VectorMemoryCollection, VectorMemoryPoint[]>();
    for (const point of points) {
      byCollection.set(point.collection, [
        ...(byCollection.get(point.collection) ?? []),
        point,
      ]);
    }
    for (const [collection, collectionPoints] of byCollection) {
      const first = collectionPoints[0];
      if (first === undefined) {
        continue;
      }
      await this.ensureCollection(collection, first.vector.length);
    await this.request(
        `collections/${collection}/points?wait=true`,
      {
        method: "PUT",
        body: {
            points: collectionPoints.map((point) => ({
              id: pointUuid(point.collection, point.id),
              vector: point.vector,
              payload: payloadFor(point),
            })),
        },
      },
    );
    }
  }

  async get(
    collection: VectorMemoryCollection,
    id: string,
  ): Promise<VectorMemoryPoint | undefined> {
    const result = await this.request(
      `collections/${collection}/points`,
      {
        method: "POST",
        body: {
          ids: [pointUuid(collection, id)],
          with_payload: true,
          with_vector: true,
        },
        notFoundValue: { result: [] },
      },
    ) as { result?: unknown[] };
    const point = result.result?.[0];
    return point === undefined
      ? undefined
      : this.fromQdrantPoint(collection, point);
  }

  async search(options: {
    collection: VectorMemoryCollection;
    vector: number[];
    filter: VectorMemoryFilter;
    limit?: number;
  }): Promise<VectorMemoryPoint[]> {
    await this.ensureCollection(options.collection, options.vector.length);
    const result = await this.request(
      `collections/${options.collection}/points/search`,
      {
        method: "POST",
        body: {
          vector: options.vector,
          filter: filterFor(options.filter),
          limit: options.limit ?? 20,
          with_payload: true,
          with_vector: true,
        },
        notFoundValue: { result: [] },
      },
    ) as { result?: unknown[] };
    return (result.result ?? []).map((point) =>
      this.fromQdrantPoint(options.collection, point),
    );
  }

  async list(options: {
    collection: VectorMemoryCollection;
    filter: VectorMemoryFilter;
    limit?: number;
  }): Promise<VectorMemoryPoint[]> {
    const result = await this.request(
      `collections/${options.collection}/points/scroll`,
      {
        method: "POST",
        body: {
          filter: filterFor(options.filter),
          limit: options.limit ?? 100,
          with_payload: true,
          with_vector: true,
        },
        notFoundValue: { result: { points: [] } },
      },
    ) as { result?: { points?: unknown[] } };
    return (result.result?.points ?? []).map((point) =>
      this.fromQdrantPoint(options.collection, point),
    );
  }

  async remove(options: {
    collection: VectorMemoryCollection;
    id: string;
  }): Promise<void> {
    await this.request(
      `collections/${options.collection}/points?wait=true`,
      {
        method: "DELETE",
        body: { points: [pointUuid(options.collection, options.id)] },
        notFoundValue: {},
      },
    );
  }

  private async ensureCollection(
    collection: VectorMemoryCollection,
    vectorSize: number,
  ): Promise<void> {
    const known = this.initialized.get(collection);
    if (known === vectorSize) {
      return;
    }
    const exists = await this.request(`collections/${collection}`, {
      method: "GET",
      notFoundValue: undefined,
    });
    if (exists === undefined) {
      await this.request(`collections/${collection}`, {
        method: "PUT",
        body: {
          vectors: {
            size: vectorSize,
            distance: this.distance,
          },
        },
        conflictValue: {},
      });
    }
    this.initialized.set(collection, vectorSize);
  }

  private fromQdrantPoint(
    collection: VectorMemoryCollection,
    raw: unknown,
  ): VectorMemoryPoint {
    const point = raw as {
      id?: string;
      payload?: Record<string, unknown>;
      vector?: number[] | Record<string, number[]>;
      score?: number;
    };
    const payload = (point.payload ?? {}) as MemoryVectorPayload;
    const vector = Array.isArray(point.vector)
      ? point.vector
      : Array.isArray(point.vector?.default)
        ? point.vector.default
        : [];
    return {
      collection,
      id: appIdFromPayload(collection, payload, point.id ?? ""),
      vector,
      payload,
      ...(typeof point.score === "number" ? { score: point.score } : {}),
    };
  }

  private async request(
    path: string,
    options: {
      method: "GET" | "POST" | "PUT" | "DELETE";
      body?: unknown;
      notFoundValue?: unknown;
      conflictValue?: unknown;
    },
  ): Promise<unknown> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: options.method,
      headers: {
        "content-type": "application/json",
        ...(this.apiKey === undefined ? {} : { "api-key": this.apiKey }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    if (response.status === 404 && "notFoundValue" in options) {
      return options.notFoundValue;
    }
    if (response.status === 409 && "conflictValue" in options) {
      return options.conflictValue;
    }
    if (!response.ok) {
      throw new QdrantUnavailableError(
        `Qdrant request failed: ${response.status} ${response.statusText}`,
      );
    }
    if (response.status === 204) {
      return {};
    }
    return response.json() as Promise<unknown>;
  }
}
