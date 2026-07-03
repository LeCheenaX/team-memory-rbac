import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  InMemoryLocalAuthorizedWorkingReplica,
  type AuthorizedViewDelta,
  type AuthorizedViewIdentity,
  type CloudCommitRecord,
  type LocalAuthorizedWorkingReplica,
  type LocalAuthorizedWorkingReplicaState,
  type MemoryActiveView,
} from "../../index.ts";
import type {
  MemoryEntity,
  MemoryEntityBranch,
  MemoryRelation,
  Resource,
  ResourceChunk,
} from "../../contracts/memory.ts";
import type {
  MemoryVectorPayload,
  ResourceCasObject,
  VectorMemoryCollection,
} from "../../memory/stores.ts";
import type { PendingOperationRecord } from "../../sync/pending.ts";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function digest(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function objectPath(rootDirectory: string, contentHash: string): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(contentHash);
  if (match?.[1] === undefined) {
    throw new Error("local CAS contentHash must be a sha256 digest");
  }
  return join(rootDirectory, "objects", "sha256", match[1].slice(0, 2), match[1]);
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(
    temporaryPath,
    `${JSON.stringify(clone(value), null, 2)}\n`,
    "utf8",
  );
  renameSync(temporaryPath, path);
}

function writeBytes(path: string, bytes: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, bytes);
  renameSync(temporaryPath, path);
}

function removePath(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function collectionPayload(
  collection: VectorMemoryCollection,
  id: string,
  record: MemoryEntity | MemoryEntityBranch | ResourceChunk,
): MemoryVectorPayload {
  return {
    ...record,
    memoryId: id,
    collection,
    rootEntityId: record.rootEntityId,
    status: record.status ?? "active",
    ...(collection === "memory_entities" ? { entityId: id } : {}),
    ...(collection === "memory_entity_branches" ? { entityBranchId: id } : {}),
    ...(collection === "resource_chunks" ? { chunkId: id } : {}),
  };
}

function vectorRecordsFor(snapshot: MemoryActiveView): Record<VectorMemoryCollection, MemoryVectorPayload[]> {
  return {
    memory_entities: snapshot.entities.map((entity) =>
      collectionPayload("memory_entities", entity.id, entity),
    ),
    memory_entity_branches: snapshot.entityBranches.map((branch) =>
      collectionPayload("memory_entity_branches", branch.id, branch),
    ),
    resource_chunks: snapshot.resourceChunks.map((chunk) =>
      collectionPayload("resource_chunks", chunk.id, chunk),
    ),
  };
}

function resourceContent(resource: Resource): string | Uint8Array | undefined {
  const metadata = resource.metadata ?? {};
  if (typeof metadata.content === "string") return metadata.content;
  if (typeof metadata.contentBase64 === "string") {
    return Buffer.from(metadata.contentBase64, "base64");
  }
  return undefined;
}

function chunkContent(chunk: ResourceChunk): string | Uint8Array | undefined {
  if (typeof chunk.text === "string" && chunk.text.length > 0) {
    return chunk.text;
  }
  return undefined;
}

function persistCasObject(
  casDirectory: string,
  contentHash: string | undefined,
  content: string | Uint8Array | undefined,
): void {
  if (contentHash === undefined || content === undefined) return;
  const actual = digest(content);
  if (actual !== contentHash) {
    throw new Error("local CAS content hash does not match bytes");
  }
  writeBytes(objectPath(casDirectory, contentHash), content);
}

function pendingCasObjects(
  pendingOperations: unknown[],
): ResourceCasObject[] {
  return pendingOperations.flatMap((operation) => {
    const objects = (operation as Partial<PendingOperationRecord>).localCasObjects;
    return Array.isArray(objects) ? objects : [];
  });
}

function assertCasObjectReadable(
  casDirectory: string,
  contentHash: string | undefined,
): void {
  if (contentHash === undefined) return;
  const path = objectPath(casDirectory, contentHash);
  if (!existsSync(path)) return;
  const bytes = readFileSync(path);
  if (digest(bytes) !== contentHash) {
    throw new Error("local CAS object failed contentHash verification");
  }
}

interface FileSystemReplicaPaths {
  state: string;
  manifest: string;
  cursor: string;
  resources: string;
  relations: string;
  history: string;
  pending: string;
  conflicts: string;
  cas: string;
  vectors: Record<VectorMemoryCollection, string>;
}

function pathsFor(directory: string): FileSystemReplicaPaths {
  return {
    state: join(directory, "state.json"),
    manifest: join(directory, "manifest.json"),
    cursor: join(directory, "sync", "cursor.json"),
    resources: join(directory, "cas", "resources.json"),
    relations: join(directory, "relations", "memory_relations.json"),
    history: join(directory, "history", "records.json"),
    pending: join(directory, "pending", "operations.json"),
    conflicts: join(directory, "conflicts", "conflicts.json"),
    cas: join(directory, "cas"),
    vectors: {
      memory_entities: join(directory, "vectors", "memory_entities.json"),
      memory_entity_branches: join(directory, "vectors", "memory_entity_branches.json"),
      resource_chunks: join(directory, "vectors", "resource_chunks.json"),
    },
  };
}

function loadStateFromStores(paths: FileSystemReplicaPaths): LocalAuthorizedWorkingReplicaState | undefined {
  const manifest = readJson<{ valid: boolean; rootEntityId?: string; branchRef?: string }>(paths.manifest);
  if (manifest === undefined) return undefined;
  const identity = readJson<AuthorizedViewIdentity>(paths.cursor);
  const entities = (readJson<MemoryVectorPayload[]>(paths.vectors.memory_entities) ?? [])
    .map((payload) => payload as unknown as MemoryEntity);
  const entityBranches = (readJson<MemoryVectorPayload[]>(paths.vectors.memory_entity_branches) ?? [])
    .map((payload) => payload as unknown as MemoryEntityBranch);
  const resourceChunks = (readJson<MemoryVectorPayload[]>(paths.vectors.resource_chunks) ?? [])
    .map((payload) => payload as unknown as ResourceChunk);
  const resources = readJson<Resource[]>(paths.resources) ?? [];
  for (const resource of resources) assertCasObjectReadable(paths.cas, resource.contentHash);
  for (const chunk of resourceChunks) assertCasObjectReadable(paths.cas, chunk.contentHash ?? chunk.metadata?.contentHash);
  const snapshot = identity === undefined || manifest.rootEntityId === undefined || manifest.branchRef === undefined
    ? undefined
    : {
        rootEntityId: manifest.rootEntityId,
        branchRef: manifest.branchRef,
        entities,
        entityBranches,
        relations: readJson<MemoryRelation[]>(paths.relations) ?? [],
        resources,
        resourceChunks,
      };
  return {
    ...(identity === undefined ? {} : { identity }),
    ...(snapshot === undefined ? {} : { snapshot }),
    historyRecords: readJson(paths.history) ?? [],
    pendingOperations: readJson(paths.pending) ?? [],
    conflicts: readJson(paths.conflicts) ?? [],
    valid: manifest.valid,
  };
}

function loadInitialState(paths: FileSystemReplicaPaths): LocalAuthorizedWorkingReplicaState | undefined {
  return loadStateFromStores(paths) ?? readJson<LocalAuthorizedWorkingReplicaState>(paths.state);
}

export class FileSystemLocalAuthorizedWorkingReplica
  implements LocalAuthorizedWorkingReplica
{
  private readonly paths: FileSystemReplicaPaths;
  private readonly delegate: InMemoryLocalAuthorizedWorkingReplica;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.paths = pathsFor(directory);
    this.delegate = new InMemoryLocalAuthorizedWorkingReplica(
      loadInitialState(this.paths),
    );
    this.persist();
  }

  inspect(): LocalAuthorizedWorkingReplicaState {
    return this.delegate.inspect();
  }

  replace(
    identity: AuthorizedViewIdentity,
    snapshot: MemoryActiveView,
  ): void {
    this.delegate.replace(identity, snapshot);
    this.persist();
  }

  applyDelta(
    identity: AuthorizedViewIdentity,
    delta: AuthorizedViewDelta,
  ): void {
    this.delegate.applyDelta(identity, delta);
    this.persist();
  }

  advance(identity: AuthorizedViewIdentity): void {
    this.delegate.advance(identity);
    this.persist();
  }

  replaceHistory(records: CloudCommitRecord[]): void {
    this.delegate.replaceHistory(records);
    this.persist();
  }

  applyHistory(records: CloudCommitRecord[]): void {
    this.delegate.applyHistory(records);
    this.persist();
  }

  replacePendingOperations(operations: unknown[]): void {
    this.delegate.replacePendingOperations(operations);
    this.persist();
  }

  invalidate(): void {
    this.delegate.clear();
    this.persist();
  }

  clear(): void {
    this.delegate.clear();
    this.persist();
  }

  readView(rootEntityId: string, branchRef: string): MemoryActiveView {
    return this.delegate.readView(rootEntityId, branchRef);
  }

  storageManifest(): ReturnType<
    InMemoryLocalAuthorizedWorkingReplica["storageManifest"]
  > {
    return this.delegate.storageManifest();
  }

  private persist(): void {
    const state = this.delegate.inspect();
    this.rebuildStructuredStores(state);
    writeJson(this.paths.state, state);
  }

  private rebuildStructuredStores(state: LocalAuthorizedWorkingReplicaState): void {
    removePath(dirname(this.paths.cursor));
    removePath(dirname(this.paths.relations));
    removePath(dirname(this.paths.history));
    removePath(dirname(this.paths.pending));
    removePath(dirname(this.paths.conflicts));
    removePath(dirname(this.paths.vectors.memory_entities));
    removePath(join(this.paths.cas, "objects"));
    writeJson(this.paths.manifest, {
      valid: state.valid,
      rootEntityId: state.snapshot?.rootEntityId,
      branchRef: state.snapshot?.branchRef,
    });
    if (state.identity !== undefined) writeJson(this.paths.cursor, state.identity);
    writeJson(this.paths.history, state.historyRecords);
    writeJson(this.paths.pending, state.pendingOperations);
    writeJson(this.paths.conflicts, state.conflicts);
    const snapshot = state.snapshot;
    if (state.valid && snapshot !== undefined) {
      writeJson(this.paths.resources, snapshot.resources);
      writeJson(this.paths.relations, snapshot.relations);
      const vectors = vectorRecordsFor(snapshot);
      writeJson(this.paths.vectors.memory_entities, vectors.memory_entities);
      writeJson(this.paths.vectors.memory_entity_branches, vectors.memory_entity_branches);
      writeJson(this.paths.vectors.resource_chunks, vectors.resource_chunks);
      for (const resource of snapshot.resources) {
        persistCasObject(this.paths.cas, resource.contentHash, resourceContent(resource));
      }
      for (const chunk of snapshot.resourceChunks) {
        persistCasObject(
          this.paths.cas,
          chunk.contentHash ?? chunk.metadata?.contentHash,
          chunkContent(chunk),
        );
      }
      for (const object of pendingCasObjects(state.pendingOperations)) {
        persistCasObject(this.paths.cas, object.contentHash, object.content);
      }
      return;
    }
    writeJson(this.paths.resources, []);
    writeJson(this.paths.relations, []);
    writeJson(this.paths.vectors.memory_entities, []);
    writeJson(this.paths.vectors.memory_entity_branches, []);
    writeJson(this.paths.vectors.resource_chunks, []);
  }
}
