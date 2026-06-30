import type {
  MemoryEntity,
  MemoryEntityBranch,
  MemoryRelation,
  Resource,
  ResourceChunk,
} from "../contracts/memory.ts";
import type {
  PermissionConstraint,
  PermissionRequest,
  PermissionSubject,
  TaskScope,
} from "../contracts/rbac.ts";
import type {
  AuthorizedMemoryRequest,
  MemoryAdapter,
  PermissionRouteResult,
  PermissionRouter,
} from "../permission-router.ts";
import type {
  CloudCommitRecord,
} from "../history/cloud-authority.ts";
import type { MemoryActiveView } from "../memory/contracts.ts";
import type {
  EntityRetrievalItem,
  MemoryQueryContext,
  MemoryQuerySource,
  MemoryRetrievalItem,
  RelationRetrievalItem,
} from "../memory/retrieval.ts";
import { InMemoryAuthorizedQuerySource } from "../memory/retrieval.ts";

export interface PermissionWatermarkProvider {
  get(subjectId: string, rootEntityId: string): Promise<string>;
}

export interface AuthorizedViewCloudSource {
  commitWatermark(): number;
  readActiveView(rootEntityId: string, branchRef: string): MemoryActiveView;
  listCommitRecords(
    rootEntityId: string,
    branchRef: string,
    afterSequence?: number,
  ): CloudCommitRecord[];
}

export class InMemoryPermissionWatermarkAuthority
  implements PermissionWatermarkProvider
{
  private readonly watermarks = new Map<string, number>();

  async get(subjectId: string, rootEntityId: string): Promise<string> {
    return String(this.watermarks.get(`${subjectId}:${rootEntityId}`) ?? 0);
  }

  advance(subjectId: string, rootEntityId: string): string {
    const key = `${subjectId}:${rootEntityId}`;
    const next = (this.watermarks.get(key) ?? 0) + 1;
    this.watermarks.set(key, next);
    return String(next);
  }
}

export interface AuthorizedSyncRequest extends PermissionRequest {
  branchRef: string;
  knownCommitWatermark?: number;
  knownPermissionWatermark?: string;
  knownTaskScopeHash?: string;
}

export interface AuthorizedViewIdentity {
  subjectId: string;
  rootEntityId: string;
  branchRef: string;
  taskScopeHash: string;
  commitWatermark: number;
  permissionWatermark: string;
}

export interface AuthorizedViewDelta {
  entities: MemoryEntity[];
  entityBranches: MemoryEntityBranch[];
  relations: MemoryRelation[];
  resources: Resource[];
  resourceChunks: ResourceChunk[];
  removeEntityCascadeIds: string[];
  removeEntityBranchIds: string[];
  removeRelationIds: string[];
  removeResourceCascadeIds: string[];
  removeResourceChunkIds: string[];
}

export type SyncEvent =
  | {
      kind: "history_commit_accepted";
      identity: AuthorizedViewIdentity;
      record: CloudCommitRecord;
    }
  | {
      kind: "history_conflict_created";
      identity: AuthorizedViewIdentity;
      record: CloudCommitRecord;
    }
  | {
      kind: "history_resolution_committed";
      identity: AuthorizedViewIdentity;
      record: CloudCommitRecord;
    }
  | {
      kind: "memory_state_delta";
      identity: AuthorizedViewIdentity;
      delta?: AuthorizedViewDelta;
      snapshot?: MemoryActiveView;
    }
  | {
      kind: "permission_changed";
      identity: AuthorizedViewIdentity;
    }
  | {
      kind: "replica_rebuild_required";
      identity: AuthorizedViewIdentity;
    };

export type AuthorizedSyncBatch =
  | {
      kind: "noop";
      identity: AuthorizedViewIdentity;
      changeCommitIds: string[];
      historyRecords: CloudCommitRecord[];
    }
  | {
      kind: "replace";
      reason: "bootstrap" | "permission_changed" | "rebuild_required";
      identity: AuthorizedViewIdentity;
      snapshot: MemoryActiveView;
      changeCommitIds: string[];
      historyRecords: CloudCommitRecord[];
    }
  | {
      kind: "delta";
      identity: AuthorizedViewIdentity;
      delta: AuthorizedViewDelta;
      changeCommitIds: string[];
      historyRecords: CloudCommitRecord[];
    };

export interface LocalAuthorizedWorkingReplicaState {
  identity?: AuthorizedViewIdentity;
  snapshot?: MemoryActiveView;
  historyRecords: CloudCommitRecord[];
  pendingOperations: unknown[];
  conflicts: unknown[];
  valid: boolean;
}

/** @deprecated Use LocalAuthorizedWorkingReplicaState. */
export type LocalAuthorizedViewState = LocalAuthorizedWorkingReplicaState;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function subjectId(subject: PermissionSubject): string {
  return subject.kind === "user" ? subject.userId : subject.agentId;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function taskScopeHash(taskScope: TaskScope | undefined): string {
  return `scope:${JSON.stringify(stableValue(taskScope ?? null))}`;
}

function valuesAllowed(
  values: string[],
  allowed: string[] | undefined,
  denied: string[] | undefined,
): boolean {
  return (
    (allowed === undefined ||
      values.some((value) => allowed.includes(value))) &&
    !values.some((value) => denied?.includes(value) === true)
  );
}

function filterAuthorizedView(
  view: MemoryActiveView,
  taskScope: TaskScope | undefined,
  constraints: PermissionConstraint,
): MemoryActiveView {
  const currentBranches = new Map(
    view.entities.flatMap((entity) => {
      const branch = view.entityBranches.find(
        (candidate) => candidate.id === entity.currentBranchId,
      );
      return branch === undefined ? [] : [[entity.id, branch] as const];
    }),
  );
  const allowedEntityIds = new Set(
    view.entities
      .filter((entity) => {
        if (entity.id === view.rootEntityId) {
          return true;
        }
        if (
          taskScope?.allowedEntityIds !== undefined &&
          !taskScope.allowedEntityIds.includes(entity.id)
        ) {
          return false;
        }
        if (taskScope?.deniedEntityIds?.includes(entity.id) === true) {
          return false;
        }
        const tags = currentBranches.get(entity.id)?.tags ?? [];
        return (
          valuesAllowed(
            tags,
            taskScope?.allowedTags,
            taskScope?.deniedTags,
          ) &&
          valuesAllowed(
            tags,
            constraints.allowedTags,
            constraints.deniedTags,
          )
        );
      })
      .map((entity) => entity.id),
  );
  const resources = view.resources.filter(
    (resource) =>
      (taskScope?.allowedResourceIds === undefined ||
        taskScope.allowedResourceIds.includes(resource.id)) &&
      taskScope?.deniedResourceIds?.includes(resource.id) !== true,
  );
  const allowedResourceIds = new Set(
    resources.map((resource) => resource.id),
  );
  const resourceChunks = view.resourceChunks.filter((chunk) =>
    allowedResourceIds.has(chunk.resourceId),
  );
  const allowedChunkIds = new Set(
    resourceChunks.map((chunk) => chunk.id),
  );
  const endpointAllowed = (kind: string, id: string): boolean =>
    kind === "memory_entity"
      ? allowedEntityIds.has(id)
      : kind === "resource"
        ? allowedResourceIds.has(id)
        : allowedChunkIds.has(id);
  const allowedRelationTypes =
    taskScope?.relationExpansionPolicy?.allowedRelationTypes ??
    constraints.allowedRelationTypes;
  const deniedRelationTypes = new Set([
    ...(taskScope?.relationExpansionPolicy?.allowedRelationTypes ===
    undefined
      ? []
      : []),
    ...(constraints.deniedRelationTypes ?? []),
  ]);
  const relations = view.relations.filter(
    (relation) =>
      (allowedRelationTypes === undefined ||
        allowedRelationTypes.includes(relation.relationType)) &&
      !deniedRelationTypes.has(relation.relationType) &&
      endpointAllowed(relation.sourceKind, relation.sourceId) &&
      endpointAllowed(relation.targetKind, relation.targetId),
  );

  return {
    rootEntityId: view.rootEntityId,
    branchRef: view.branchRef,
    entities: view.entities.filter((entity) =>
      allowedEntityIds.has(entity.id),
    ),
    entityBranches: view.entityBranches.filter(
      (branch) =>
        allowedEntityIds.has(branch.entityId) &&
        valuesAllowed(
          branch.tags,
          taskScope?.allowedTags,
          taskScope?.deniedTags,
        ) &&
        valuesAllowed(
          branch.tags,
          constraints.allowedTags,
          constraints.deniedTags,
        ),
    ),
    relations,
    resources,
    resourceChunks,
  };
}

function authorizedHistoryRecords(
  records: CloudCommitRecord[],
  view: MemoryActiveView,
): CloudCommitRecord[] {
  const entityIds = new Set(view.entities.map(({ id }) => id));
  const branchIds = new Set(view.entityBranches.map(({ id }) => id));
  const relationIds = new Set(view.relations.map(({ id }) => id));
  const resourceIds = new Set(view.resources.map(({ id }) => id));
  const chunkIds = new Set(view.resourceChunks.map(({ id }) => id));
  const allowed = (operation: CloudCommitRecord["operations"][number]): boolean => {
    const input = operation.input;
    switch (input.kind) {
      case "create_entity": return entityIds.has(input.entity.id);
      case "create_entity_branch": return branchIds.has(input.branch.id);
      case "create_relation": return relationIds.has(input.relation.id);
      case "create_resource": return resourceIds.has(input.resource.id);
      case "create_resource_chunk": return chunkIds.has(input.chunk.id);
      case "revise_resource": return resourceIds.has(input.resourceId);
      case "tombstone_entity": return entityIds.has(input.targetId);
      case "tombstone_entity_branch": return branchIds.has(input.targetId);
      case "tombstone_relation": return relationIds.has(input.targetId);
      case "tombstone_resource": return resourceIds.has(input.targetId);
      case "replace_relation": return relationIds.has(input.replacement.id);
      // These carry only History references. Retaining them lets a local
      // pending overlay converge after a cloud revert or resolution.
      case "revert_commit":
      case "resolve_conflict": return true;
    }
  };
  return records.flatMap((record) => {
    const operations = record.operations.filter(allowed);
    if (operations.length === 0) return [];
    return [{
      ...clone(record),
      commit: { ...clone(record.commit), operationIds: operations.map(({ id }) => id) },
      operations: clone(operations),
    }];
  });
}

export function syncEventsForBatch(batch: AuthorizedSyncBatch): SyncEvent[] {
  const history = batch.historyRecords.map((record): SyncEvent =>
    record.status === "conflicted"
      ? { kind: "history_conflict_created", identity: batch.identity, record }
      : record.resolution !== undefined
        ? { kind: "history_resolution_committed", identity: batch.identity, record }
        : { kind: "history_commit_accepted", identity: batch.identity, record },
  );
  if (batch.kind === "noop") return history;
  if (batch.kind === "delta") {
    return [...history, { kind: "memory_state_delta", identity: batch.identity, delta: batch.delta }];
  }
  return [
    ...history,
    ...(batch.reason === "permission_changed"
      ? [{ kind: "permission_changed" as const, identity: batch.identity }]
      : []),
    ...(batch.reason === "rebuild_required"
      ? [{ kind: "replica_rebuild_required" as const, identity: batch.identity }]
      : []),
    { kind: "memory_state_delta", identity: batch.identity, snapshot: batch.snapshot },
  ];
}

function emptyDelta(): AuthorizedViewDelta {
  return {
    entities: [],
    entityBranches: [],
    relations: [],
    resources: [],
    resourceChunks: [],
    removeEntityCascadeIds: [],
    removeEntityBranchIds: [],
    removeRelationIds: [],
    removeResourceCascadeIds: [],
    removeResourceChunkIds: [],
  };
}

function deltaFromRecords(
  records: CloudCommitRecord[],
  view: MemoryActiveView,
): AuthorizedViewDelta | undefined {
  const delta = emptyDelta();
  const entityIds = new Set<string>();
  const branchIds = new Set<string>();
  const relationIds = new Set<string>();
  const resourceIds = new Set<string>();
  const chunkIds = new Set<string>();
  let rebuildRequired = false;

  for (const record of records) {
    if (record.status !== "accepted") continue;
    for (const operation of record.operations) {
      const input = operation.input;
      switch (input.kind) {
        case "create_entity":
          entityIds.add(input.entity.id);
          break;
        case "create_entity_branch":
          branchIds.add(input.branch.id);
          entityIds.add(input.branch.entityId);
          break;
        case "create_relation":
          relationIds.add(input.relation.id);
          break;
        case "create_resource":
          resourceIds.add(input.resource.id);
          break;
        case "create_resource_chunk":
          chunkIds.add(input.chunk.id);
          break;
        case "revise_resource":
          resourceIds.add(input.resourceId);
          break;
        case "tombstone_resource":
          delta.removeResourceCascadeIds.push(input.targetId);
          break;
        case "tombstone_entity":
          if (input.targetId === view.rootEntityId) {
            rebuildRequired = true;
          } else {
            delta.removeEntityCascadeIds.push(input.targetId);
          }
          break;
        case "tombstone_entity_branch":
          delta.removeEntityBranchIds.push(input.targetId);
          break;
        case "tombstone_relation":
          delta.removeRelationIds.push(input.targetId);
          break;
        case "replace_relation":
          rebuildRequired = true;
          break;
        case "revert_commit":
          rebuildRequired = true;
          break;
        case "resolve_conflict":
          break;
      }
    }
  }
  if (rebuildRequired) {
    return undefined;
  }

  for (const id of entityIds) {
    const entity = view.entities.find((candidate) => candidate.id === id);
    if (entity === undefined) {
      delta.removeEntityCascadeIds.push(id);
    } else {
      delta.entities.push(clone(entity));
      delta.entityBranches.push(
        ...view.entityBranches
          .filter((branch) => branch.entityId === id)
          .map(clone),
      );
    }
  }
  for (const id of branchIds) {
    const branch = view.entityBranches.find(
      (candidate) => candidate.id === id,
    );
    if (branch === undefined) {
      delta.removeEntityBranchIds.push(id);
    } else if (
      !delta.entityBranches.some((candidate) => candidate.id === id)
    ) {
      delta.entityBranches.push(clone(branch));
    }
  }
  for (const id of relationIds) {
    const relation = view.relations.find(
      (candidate) => candidate.id === id,
    );
    if (relation === undefined) {
      delta.removeRelationIds.push(id);
    } else {
      delta.relations.push(clone(relation));
    }
  }
  for (const id of resourceIds) {
    const resource = view.resources.find(
      (candidate) => candidate.id === id,
    );
    if (resource === undefined) {
      delta.removeResourceCascadeIds.push(id);
    } else {
      delta.resources.push(clone(resource));
    }
  }
  for (const id of chunkIds) {
    const chunk = view.resourceChunks.find(
      (candidate) => candidate.id === id,
    );
    if (chunk === undefined) {
      delta.removeResourceChunkIds.push(id);
    } else {
      delta.resourceChunks.push(clone(chunk));
    }
  }
  return delta;
}

export class CloudAuthorizedViewAdapter
  implements MemoryAdapter<AuthorizedSyncBatch, AuthorizedSyncRequest>
{
  private readonly cloud: AuthorizedViewCloudSource;
  private readonly permissionWatermarks: PermissionWatermarkProvider;

  constructor(
    cloud: AuthorizedViewCloudSource,
    permissionWatermarks: PermissionWatermarkProvider,
  ) {
    this.cloud = cloud;
    this.permissionWatermarks = permissionWatermarks;
  }

  async execute(
    request: AuthorizedMemoryRequest<AuthorizedSyncRequest>,
  ): Promise<AuthorizedSyncBatch> {
    if (
      request.action !== "read" &&
      request.action !== "search"
    ) {
      throw new Error("sync requires read or search authorization");
    }
    const permissionWatermark = await this.permissionWatermarks.get(
      subjectId(request.subject),
      request.rootEntityId,
    );
    const commitWatermark = this.cloud.commitWatermark();
    const identity: AuthorizedViewIdentity = {
      subjectId: subjectId(request.subject),
      rootEntityId: request.rootEntityId,
      branchRef: request.branchRef,
      taskScopeHash: taskScopeHash(request.taskScope),
      commitWatermark,
      permissionWatermark,
    };
    const active = filterAuthorizedView(
      this.cloud.readActiveView(
        request.rootEntityId,
        request.branchRef,
      ),
      request.taskScope,
      request.authorization.constraints,
    );
    const records = this.cloud
      .listCommitRecords(
        request.rootEntityId,
        request.branchRef,
        request.knownCommitWatermark ?? 0,
      );
    const replacing =
      request.knownCommitWatermark === undefined ||
      request.knownPermissionWatermark !== permissionWatermark ||
      request.knownTaskScopeHash !== identity.taskScopeHash;
    const historyRecords = authorizedHistoryRecords(
      replacing
        ? this.cloud.listCommitRecords(
            request.rootEntityId,
            request.branchRef,
            0,
          )
        : records,
      active,
    );
    const acceptedRecords = historyRecords.filter(
      (record) => record.status === "accepted",
    );
    const changeCommitIds = acceptedRecords.map((record) => record.commit.id);

    if (request.knownCommitWatermark === undefined) {
      return {
        kind: "replace",
        reason: "bootstrap",
        identity,
        snapshot: active,
        changeCommitIds,
        historyRecords,
      };
    }
    if (replacing) {
      return {
        kind: "replace",
        reason: "permission_changed",
        identity,
        snapshot: active,
        changeCommitIds,
        historyRecords,
      };
    }
    if (acceptedRecords.length === 0) {
      return { kind: "noop", identity, changeCommitIds: [], historyRecords };
    }
    const delta = deltaFromRecords(acceptedRecords, active);
    if (delta === undefined) {
      return {
        kind: "replace",
        reason: "rebuild_required",
        identity,
        snapshot: active,
        changeCommitIds,
        historyRecords,
      };
    }
    return { kind: "delta", identity, delta, changeCommitIds, historyRecords };
  }
}

function upsert<T extends { id: string }>(
  values: T[],
  additions: T[],
): T[] {
  const map = new Map(values.map((value) => [value.id, clone(value)]));
  for (const addition of additions) {
    map.set(addition.id, clone(addition));
  }
  return [...map.values()];
}

export class InMemoryLocalAuthorizedWorkingReplica
  implements LocalAuthorizedWorkingReplica
{
  private state: LocalAuthorizedWorkingReplicaState;

  constructor(initialState?: LocalAuthorizedWorkingReplicaState) {
    this.state =
      initialState === undefined
        ? {
            historyRecords: [],
            pendingOperations: [],
            conflicts: [],
            valid: false,
          }
        : clone(initialState);
  }

  inspect(): LocalAuthorizedWorkingReplicaState {
    return clone(this.state);
  }

  replace(
    identity: AuthorizedViewIdentity,
    snapshot: MemoryActiveView,
  ): void {
    this.state = {
      identity: clone(identity),
      snapshot: clone(snapshot),
      historyRecords: [],
      pendingOperations: clone(this.state.pendingOperations),
      conflicts: clone(this.state.conflicts),
      valid: true,
    };
  }

  applyDelta(
    identity: AuthorizedViewIdentity,
    delta: AuthorizedViewDelta,
  ): void {
    const current = this.requireSnapshot();
    const entityCascadeIds = new Set(delta.removeEntityCascadeIds);
    const resourceCascadeIds = new Set(delta.removeResourceCascadeIds);
    const next: MemoryActiveView = {
      rootEntityId: current.rootEntityId,
      branchRef: current.branchRef,
      entities: upsert(
        current.entities.filter(
          (entity) => !entityCascadeIds.has(entity.id),
        ),
        delta.entities,
      ),
      entityBranches: upsert(
        current.entityBranches.filter(
          (branch) =>
            !entityCascadeIds.has(branch.entityId) &&
            !delta.removeEntityBranchIds.includes(branch.id),
        ),
        delta.entityBranches,
      ),
      relations: upsert(
        current.relations.filter(
          (relation) =>
            !delta.removeRelationIds.includes(relation.id) &&
            !entityCascadeIds.has(relation.sourceId) &&
            !entityCascadeIds.has(relation.targetId) &&
            !resourceCascadeIds.has(relation.sourceId) &&
            !resourceCascadeIds.has(relation.targetId),
        ),
        delta.relations,
      ),
      resources: upsert(
        current.resources.filter(
          (resource) => !resourceCascadeIds.has(resource.id),
        ),
        delta.resources,
      ),
      resourceChunks: upsert(
        current.resourceChunks.filter(
          (chunk) =>
            !resourceCascadeIds.has(chunk.resourceId) &&
            !delta.removeResourceChunkIds.includes(chunk.id),
        ),
        delta.resourceChunks,
      ),
    };
    this.state = {
      ...this.state,
      identity: clone(identity),
      snapshot: next,
      valid: true,
    };
  }

  advance(identity: AuthorizedViewIdentity): void {
    if (this.state.snapshot === undefined) {
      throw new Error("cannot advance a missing local snapshot");
    }
    this.state = {
      ...this.state,
      identity: clone(identity),
      valid: true,
    };
  }

  replaceHistory(records: CloudCommitRecord[]): void {
    this.state = { ...this.state, historyRecords: clone(records) };
  }

  replacePendingOperations(operations: unknown[]): void {
    this.state = { ...this.state, pendingOperations: clone(operations) };
  }

  applyHistory(records: CloudCommitRecord[]): void {
    const byCommit = new Map(
      this.state.historyRecords.map((record) => [record.commit.id, clone(record)]),
    );
    for (const record of records) byCommit.set(record.commit.id, clone(record));
    this.state = { ...this.state, historyRecords: [...byCommit.values()] };
  }

  invalidate(): void {
    this.state = {
      historyRecords: [],
      pendingOperations: clone(this.state.pendingOperations),
      conflicts: clone(this.state.conflicts),
      valid: false,
    };
  }

  clear(): void {
    this.state = {
      historyRecords: [],
      pendingOperations: [],
      conflicts: [],
      valid: false,
    };
  }

  readView(rootEntityId: string, branchRef: string): MemoryActiveView {
    const snapshot = this.requireSnapshot();
    if (
      snapshot.rootEntityId !== rootEntityId ||
      snapshot.branchRef !== branchRef
    ) {
      throw new Error("local authorized view identity mismatch");
    }
    return clone(snapshot);
  }

  storageManifest(): {
    resourceCas: boolean;
    vectorPayloads: boolean;
    memoryRelations: boolean;
    historyOperationTree: boolean;
    pendingOperations: boolean;
    syncCursor: boolean;
    conflicts: boolean;
    completeCommitHistory: false;
    completeOperationHistory: false;
  } {
    return {
      resourceCas: true,
      vectorPayloads: true,
      memoryRelations: true,
      historyOperationTree: true,
      pendingOperations: true,
      syncCursor: true,
      conflicts: true,
      completeCommitHistory: false,
      completeOperationHistory: false,
    };
  }

  private requireSnapshot(): MemoryActiveView {
    if (!this.state.valid || this.state.snapshot === undefined) {
      throw new Error("local authorized view is invalid");
    }
    return this.state.snapshot;
  }
}

export interface LocalAuthorizedWorkingReplica {
  inspect(): LocalAuthorizedWorkingReplicaState;
  replace(
    identity: AuthorizedViewIdentity,
    snapshot: MemoryActiveView,
  ): void;
  applyDelta(
    identity: AuthorizedViewIdentity,
    delta: AuthorizedViewDelta,
  ): void;
  advance(identity: AuthorizedViewIdentity): void;
  replaceHistory(records: CloudCommitRecord[]): void;
  applyHistory(records: CloudCommitRecord[]): void;
  replacePendingOperations(operations: unknown[]): void;
  invalidate(): void;
  clear(): void;
  readView(rootEntityId: string, branchRef: string): MemoryActiveView;
}

/** @deprecated Use LocalAuthorizedWorkingReplica. */
export type LocalAuthorizedViewStore = LocalAuthorizedWorkingReplica;
/** @deprecated Use InMemoryLocalAuthorizedWorkingReplica. */
export const InMemoryLocalAuthorizedViewStore =
  InMemoryLocalAuthorizedWorkingReplica;

export class AuthorizedWorkingReplicaSynchronizer {
  private readonly router: PermissionRouter<
    AuthorizedSyncBatch,
    AuthorizedSyncRequest
  >;
  private readonly store: LocalAuthorizedWorkingReplica;

  constructor(
    router: PermissionRouter<
      AuthorizedSyncBatch,
      AuthorizedSyncRequest
    >,
    store: LocalAuthorizedWorkingReplica,
  ) {
    this.router = router;
    this.store = store;
  }

  async sync(
    request: Omit<
      AuthorizedSyncRequest,
      | "knownCommitWatermark"
      | "knownPermissionWatermark"
      | "knownTaskScopeHash"
    >,
  ): Promise<PermissionRouteResult<AuthorizedSyncBatch>> {
    const current = this.store.inspect().identity;
    const routed = await this.router.execute({
      ...request,
      ...(current === undefined
        ? {}
        : {
            knownCommitWatermark: current.commitWatermark,
            knownPermissionWatermark: current.permissionWatermark,
            knownTaskScopeHash: current.taskScopeHash,
          }),
    });
    if (!("value" in routed)) {
      this.store.invalidate();
      return routed;
    }
    const batch = routed.value;
    if (batch.kind === "replace") {
      this.store.replace(batch.identity, batch.snapshot);
      this.store.replaceHistory(batch.historyRecords);
    } else if (batch.kind === "delta") {
      this.store.applyDelta(batch.identity, batch.delta);
      this.store.applyHistory(batch.historyRecords);
    } else {
      this.store.advance(batch.identity);
      this.store.applyHistory(batch.historyRecords);
    }
    return routed;
  }
}

/** @deprecated Use AuthorizedWorkingReplicaSynchronizer. */
export const AuthorizedViewSynchronizer =
  AuthorizedWorkingReplicaSynchronizer;

export class SynchronizedLocalQuerySource implements MemoryQuerySource {
  private readonly delegate: InMemoryAuthorizedQuerySource;
  private readonly store: LocalAuthorizedViewStore;
  private readonly permissionWatermarks: PermissionWatermarkProvider;

  constructor(
    store: LocalAuthorizedViewStore,
    permissionWatermarks: PermissionWatermarkProvider,
  ) {
    this.store = store;
    this.permissionWatermarks = permissionWatermarks;
    this.delegate = new InMemoryAuthorizedQuerySource(
      (rootEntityId, branchRef) =>
        this.store.readView(rootEntityId, branchRef),
      "local_snapshot",
    );
  }

  async keywordSearch(
    context: MemoryQueryContext,
    text: string,
    limit?: number,
  ): Promise<MemoryRetrievalItem[]> {
    await this.assertFresh(context);
    return this.delegate.keywordSearch(context, text, limit);
  }

  async semanticSearch(
    context: MemoryQueryContext,
    embedding: number[],
    limit?: number,
  ): Promise<MemoryRetrievalItem[]> {
    await this.assertFresh(context);
    return this.delegate.semanticSearch(context, embedding, limit);
  }

  async entitySearch(
    context: MemoryQueryContext,
    options: {
      text?: string;
      entityIds?: string[];
      limit?: number;
    },
  ): Promise<EntityRetrievalItem[]> {
    await this.assertFresh(context);
    return this.delegate.entitySearch(context, options);
  }

  async expandRelations(
    context: MemoryQueryContext,
    options: Parameters<MemoryQuerySource["expandRelations"]>[1],
  ): Promise<RelationRetrievalItem[]> {
    await this.assertFresh(context);
    return this.delegate.expandRelations(context, options);
  }

  async evidenceFor(
    context: MemoryQueryContext,
    entityIds: string[],
  ): Promise<Map<string, ResourceChunk[]>> {
    await this.assertFresh(context);
    return this.delegate.evidenceFor(context, entityIds);
  }

  private async assertFresh(context: MemoryQueryContext): Promise<void> {
    const identity = this.store.inspect().identity;
    if (
      identity === undefined ||
      identity.rootEntityId !== context.rootEntityId ||
      identity.branchRef !== context.branchRef
    ) {
      throw new Error("local authorized view is missing");
    }
    const current = await this.permissionWatermarks.get(
      identity.subjectId,
      identity.rootEntityId,
    );
    if (current !== identity.permissionWatermark) {
      this.store.invalidate();
      throw new Error("local authorized view permission watermark changed");
    }
  }
}
