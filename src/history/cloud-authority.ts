import type {
  MemoryActor,
  MemoryCommit,
  MemoryOperation,
  MemoryOperationInput,
  HistoryWriteCommand,
  HistoryWriteResult,
  ConflictResolutionKind,
} from "../contracts/history.ts";
import type {
  MemoryObjectKind,
} from "../contracts/memory.ts";
import type {
  MemoryAction,
  PermissionRequest,
} from "../contracts/rbac.ts";
import type {
  AuthorizedMemoryRequest,
  MemoryAdapter,
} from "../permission-router.ts";
import { InMemoryMemoryAuthority } from "../memory/authority.ts";
import type {
  MemoryActiveView,
  MemoryAuthoritySeed,
} from "../memory/contracts.ts";

type MemoryWriteCommand = HistoryWriteCommand;
type MemoryWriteResult = HistoryWriteResult;

export interface CloudMemoryWriteCommand extends MemoryWriteCommand {
  expectedHeadCommitId?: string;
  clientMutationId: string;
}

export interface CloudCommitRecord {
  sequence: number;
  clientMutationId: string;
  targetBranchRef: string;
  storedBranchRef: string;
  conflictKeys: string[];
  commit: MemoryCommit;
  operations: MemoryOperation[];
  status: "accepted" | "conflicted";
  resolution?: {
    resolvedConflictIds: string[];
    resolvedIncomingCommitIds: string[];
    resolutionKind: ConflictResolutionKind;
  };
}

export interface MemoryConflict {
  id: string;
  rootEntityId: string;
  targetBranchRef: string;
  conflictBranchRef: string;
  baseCommitId?: string;
  remoteHeadCommitId: string;
  remoteConflictingCommitIds: string[];
  incomingCommitId: string;
  conflictKeys: string[];
  remoteActor: MemoryActor;
  incomingActor: MemoryActor;
  status: "unresolved" | "resolved";
  createdAt: string;
  resolvedByCommitId?: string;
}

export interface CloudOutboxEvent {
  id: string;
  sequence: number;
  rootEntityId: string;
  branchRef: string;
  kind: "commit_accepted" | "conflict_created";
  commitId: string;
}

export type CloudMemoryWriteResult =
  | {
      status: "accepted";
      sequence: number;
      write: MemoryWriteResult;
    }
  | {
      status: "conflict";
      sequence: number;
      conflict: MemoryConflict;
      incoming: MemoryWriteResult;
    };

export interface ConflictResolutionCommand extends PermissionRequest {
  branchRef: string;
  clientMutationId: string;
  commit: {
    id: string;
    message?: string;
  };
  conflictIds: string[];
  resolutionKind: ConflictResolutionKind;
  manualOperation?: MemoryOperationInput;
  manualAction?: MemoryAction;
  manualResourceKind?: MemoryObjectKind;
  provenance?: MemoryOperation["provenance"];
}

export interface ConflictResolutionResult {
  sequence: number;
  resolution: CloudCommitRecord;
  applied: CloudCommitRecord[];
}

interface AcceptedRequestRecord {
  sequence: number;
  request: AuthorizedMemoryRequest<CloudMemoryWriteCommand>;
}

interface IdempotencyRecord {
  fingerprint: string;
  result: CloudMemoryWriteResult;
}

interface ResolutionIdempotencyRecord {
  fingerprint: string;
  result: ConflictResolutionResult;
}

function clone<T>(value: T): T {
  return structuredClone(value);
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

function requestFingerprint<T extends { authorization: unknown }>(
  request: T,
): string {
  const { authorization: _authorization, ...command } = request;
  return JSON.stringify(stableValue(command));
}

function withoutTimestamps<T extends { createdAt?: string; updatedAt?: string }>(
  value: T,
): Omit<T, "createdAt" | "updatedAt"> {
  const {
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...rest
  } = value;
  return rest;
}

function operationEffect(operation: MemoryOperationInput): string {
  let effect: unknown;
  switch (operation.kind) {
    case "create_entity":
      effect = {
        kind: operation.kind,
        entity: withoutTimestamps(operation.entity),
      };
      break;
    case "create_entity_branch": {
      const { id: _id, ...branch } = withoutTimestamps(operation.branch);
      effect = { kind: operation.kind, branch };
      break;
    }
    case "create_relation": {
      const { id: _id, ...relation } = withoutTimestamps(
        operation.relation,
      );
      effect = { kind: operation.kind, relation };
      break;
    }
    case "create_resource":
      effect = {
        kind: operation.kind,
        resource: withoutTimestamps(operation.resource),
      };
      break;
    case "create_resource_chunk":
      effect = {
        kind: operation.kind,
        chunk: withoutTimestamps(operation.chunk),
      };
      break;
    case "revise_resource":
      effect = {
        kind: operation.kind,
        resourceId: operation.resourceId,
        contentHash: operation.contentHash,
        metadata: operation.metadata,
      };
      break;
    case "replace_relation": {
      const { id: _id, ...replacement } = withoutTimestamps(
        operation.replacement,
      );
      effect = {
        kind: operation.kind,
        previousRelationId: operation.previousRelationId,
        replacement,
      };
      break;
    }
    case "tombstone_resource":
    case "tombstone_entity":
    case "tombstone_entity_branch":
    case "tombstone_relation":
      effect = { kind: operation.kind, targetId: operation.targetId };
      break;
    case "revert_commit":
      effect = {
        kind: operation.kind,
        targetCommitId: operation.targetCommitId,
      };
      break;
    case "resolve_conflict":
      effect = operation;
      break;
  }
  return JSON.stringify(stableValue(effect));
}

function actorFrom(command: CloudMemoryWriteCommand): MemoryActor {
  return command.subject.kind === "user"
    ? { kind: "user", id: command.subject.userId }
    : { kind: "agent", id: command.subject.agentId };
}

function relationLogicalKey(
  relation: Extract<
    MemoryOperationInput,
    { kind: "create_relation" }
  >["relation"],
): string {
  return [
    "relation",
    relation.sourceKind,
    relation.sourceId,
    relation.relationType,
    relation.role ?? "",
    relation.ordinal ?? "",
  ].join(":");
}

export function conflictKeysForOperation(
  operation: MemoryOperationInput,
): string[] {
  switch (operation.kind) {
    case "create_entity":
      return [`entity:${operation.entity.id}`];
    case "create_entity_branch":
      return [
        `entity-branch:${operation.branch.entityId}:${operation.branch.branchRef}`,
      ];
    case "create_relation":
      return [
        `relation:${operation.relation.id}`,
        relationLogicalKey(operation.relation),
      ];
    case "replace_relation":
      return [
        `relation:${operation.previousRelationId}`,
        `relation:${operation.replacement.id}`,
        relationLogicalKey(operation.replacement),
      ];
    case "create_resource":
      return [`resource:${operation.resource.id}`];
    case "revise_resource":
      return [`resource:${operation.resourceId}`];
    case "create_resource_chunk":
      return [`resource-chunk:${operation.chunk.id}`];
    case "tombstone_resource":
      return [`resource:${operation.targetId}`];
    case "tombstone_entity":
      return [`entity:${operation.targetId}`];
    case "tombstone_entity_branch":
      return [`entity-branch-id:${operation.targetId}`];
    case "tombstone_relation":
      return [`relation:${operation.targetId}`];
    case "revert_commit":
      return [`commit-effect:${operation.targetCommitId}`];
    case "resolve_conflict":
      return operation.resolvedConflictIds.map(
        (conflictId) => `conflict-resolution:${conflictId}`,
      );
  }
}

function operationWithResolutionIds(
  operation: MemoryOperationInput,
  suffix: string,
): MemoryOperationInput {
  const id = `${operation.id}:${suffix}`;
  if (operation.kind === "replace_relation") {
    return {
      ...clone(operation),
      id,
      replacementOperationId: `${operation.replacementOperationId}:${suffix}`,
    };
  }
  return { ...clone(operation), id };
}

function operationForBranch(
  operation: MemoryOperationInput,
  branchRef: string,
): MemoryOperationInput {
  if (operation.kind === "create_entity_branch") {
    return {
      ...operation,
      branch: { ...operation.branch, branchRef },
    };
  }
  if (operation.kind === "create_relation") {
    return {
      ...operation,
      relation: { ...operation.relation, branchRef },
    };
  }
  if (operation.kind === "replace_relation") {
    return {
      ...operation,
      replacement: { ...operation.replacement, branchRef },
    };
  }
  return operation;
}

function seedForBranch(
  view: MemoryActiveView,
  branchRef: string,
): MemoryAuthoritySeed {
  return {
    entities: clone(view.entities),
    entityBranches: view.entityBranches.map((branch) => ({
      ...clone(branch),
      branchRef,
    })),
    relations: view.relations.map((relation) => ({
      ...clone(relation),
      branchRef,
    })),
    resources: clone(view.resources),
    resourceChunks: clone(view.resourceChunks),
  };
}

function conflictSeedForOperation(
  view: MemoryActiveView,
  branchRef: string,
  operation: MemoryOperationInput,
): MemoryAuthoritySeed {
  const seed = seedForBranch(view, branchRef);
  if (operation.kind === "create_resource_chunk") {
    seed.resourceChunks = (seed.resourceChunks ?? []).filter(
      (chunk) => chunk.id !== operation.chunk.id,
    );
  } else if (operation.kind === "create_resource") {
    seed.resources = (seed.resources ?? []).filter(
      (resource) => resource.id !== operation.resource.id,
    );
    seed.resourceChunks = (seed.resourceChunks ?? []).filter(
      (chunk) => chunk.resourceId !== operation.resource.id,
    );
  } else if (operation.kind === "create_entity") {
    seed.entities = (seed.entities ?? []).filter(
      (entity) => entity.id !== operation.entity.id,
    );
    seed.entityBranches = (seed.entityBranches ?? []).filter(
      (entityBranch) =>
        entityBranch.entityId !== operation.entity.id,
    );
    seed.relations = (seed.relations ?? []).filter(
      (relation) =>
        relation.sourceId !== operation.entity.id &&
        relation.targetId !== operation.entity.id,
    );
  } else if (operation.kind === "create_entity_branch") {
    seed.entityBranches = (seed.entityBranches ?? []).filter(
      (entityBranch) => entityBranch.id !== operation.branch.id,
    );
  } else if (operation.kind === "create_relation") {
    const incomingKeys = new Set(conflictKeysForOperation(operation));
    seed.relations = (seed.relations ?? []).filter((relation) => {
      const keys = conflictKeysForOperation({
        kind: "create_relation",
        id: `key:${relation.id}`,
        relation,
      });
      return !keys.some((key) => incomingKeys.has(key));
    });
  }
  return seed;
}

export interface CloudMemoryAuthority
  extends MemoryAdapter<CloudMemoryWriteResult, CloudMemoryWriteCommand> {
  readActiveView(
    rootEntityId: string,
    branchRef: string,
  ): MemoryActiveView;
  listCommitRecords(
    rootEntityId: string,
    branchRef: string,
    afterSequence?: number,
  ): CloudCommitRecord[];
  listConflicts(
    rootEntityId: string,
    branchRef: string,
  ): MemoryConflict[];
  listOutbox(afterSequence?: number): CloudOutboxEvent[];
  commitWatermark(): number;
  headCommitId(
    rootEntityId: string,
    branchRef: string,
  ): string | undefined;
  resolveConflict(
    request: AuthorizedMemoryRequest<ConflictResolutionCommand>,
  ): Promise<ConflictResolutionResult>;
}

export class ConflictResolutionAdapter
  implements
    MemoryAdapter<ConflictResolutionResult, ConflictResolutionCommand>
{
  private readonly cloud: CloudMemoryAuthority;

  constructor(cloud: CloudMemoryAuthority) {
    this.cloud = cloud;
  }

  execute(
    request: AuthorizedMemoryRequest<ConflictResolutionCommand>,
  ): Promise<ConflictResolutionResult> {
    return this.cloud.resolveConflict(request);
  }
}

export class InMemoryCloudMemoryAuthority
  implements CloudMemoryAuthority
{
  private core: InMemoryMemoryAuthority;
  private readonly seed: MemoryAuthoritySeed;
  private readonly records: CloudCommitRecord[] = [];
  private readonly conflicts: MemoryConflict[] = [];
  private readonly outbox: CloudOutboxEvent[] = [];
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly acceptedRequests: AcceptedRequestRecord[] = [];
  private readonly conflictAuthorities = new Map<
    string,
    InMemoryMemoryAuthority
  >();
  private readonly conflictedRequests = new Map<
    string,
    AuthorizedMemoryRequest<CloudMemoryWriteCommand>
  >();
  private readonly resolutionIdempotency = new Map<
    string,
    ResolutionIdempotencyRecord
  >();
  private sequence = 0;

  constructor(seed: MemoryAuthoritySeed = {}) {
    this.seed = clone(seed);
    this.core = new InMemoryMemoryAuthority(clone(seed));
  }

  async execute(
    request: AuthorizedMemoryRequest<CloudMemoryWriteCommand>,
  ): Promise<CloudMemoryWriteResult> {
    if (request.clientMutationId.length === 0) {
      throw new Error("clientMutationId must be non-empty");
    }
    const idempotencyKey = [
      request.rootEntityId,
      request.branchRef,
      request.clientMutationId,
    ].join(":");
    const prior = this.idempotency.get(idempotencyKey);
    if (prior !== undefined) {
      if (prior.fingerprint !== requestFingerprint(request)) {
        throw new Error(
          "clientMutationId was already used for a different command",
        );
      }
      return clone(prior.result);
    }

    const head = this.headCommitId(
      request.rootEntityId,
      request.branchRef,
    );
    const keys = conflictKeysForOperation(request.operation);
    const conflictingKeys = this.conflictingKeysSince(
      request.rootEntityId,
      request.branchRef,
      request.expectedHeadCommitId,
      head,
      keys,
    );

    const equivalent =
      conflictingKeys.length === 0
        ? undefined
        : this.equivalentAcceptedRecordSince(
            request,
            conflictingKeys,
          );
    const result =
      equivalent !== undefined
        ? {
            status: "accepted" as const,
            sequence: equivalent.sequence,
            write: {
              commit: clone(equivalent.commit),
              operations: clone(equivalent.operations),
            },
          }
        : conflictingKeys.length === 0
          ? await this.accept(request, keys)
          : await this.captureConflict(
              request,
              head,
              keys,
              conflictingKeys,
            );
    this.idempotency.set(idempotencyKey, {
      fingerprint: requestFingerprint(request),
      result: clone(result),
    });
    return clone(result);
  }

  readActiveView(
    rootEntityId: string,
    branchRef: string,
  ): MemoryActiveView {
    return this.core.readActiveView(rootEntityId, branchRef);
  }

  readConflictView(
    conflictBranchRef: string,
  ): MemoryActiveView | undefined {
    const authority = this.conflictAuthorities.get(conflictBranchRef);
    const conflict = this.conflicts.find(
      (candidate) =>
        candidate.conflictBranchRef === conflictBranchRef,
    );
    if (authority === undefined || conflict === undefined) {
      return undefined;
    }
    return authority.readActiveView(
      conflict.rootEntityId,
      conflictBranchRef,
    );
  }

  listCommitRecords(
    rootEntityId: string,
    branchRef: string,
    afterSequence = 0,
  ): CloudCommitRecord[] {
    return clone(
      this.records.filter(
        (record) =>
          record.commit.rootEntityId === rootEntityId &&
          record.targetBranchRef === branchRef &&
          record.sequence > afterSequence,
      ),
    );
  }

  listConflicts(
    rootEntityId: string,
    branchRef: string,
  ): MemoryConflict[] {
    return clone(
      this.conflicts.filter(
        (conflict) =>
          conflict.rootEntityId === rootEntityId &&
          conflict.targetBranchRef === branchRef,
      ),
    );
  }

  listOutbox(afterSequence = 0): CloudOutboxEvent[] {
    return clone(
      this.outbox.filter((event) => event.sequence > afterSequence),
    );
  }

  commitWatermark(): number {
    return this.sequence;
  }

  headCommitId(
    rootEntityId: string,
    branchRef: string,
  ): string | undefined {
    return this.core
      .listBranches(rootEntityId)
      .find((branch) => branch.branchRef === branchRef)?.headCommitId;
  }

  async rebuildActiveProjection(): Promise<void> {
    const rebuilt = new InMemoryMemoryAuthority(clone(this.seed));
    for (const record of this.acceptedRequests) {
      await rebuilt.execute(clone(record.request));
    }
    this.core = rebuilt;
  }

  async resolveConflict(
    request: AuthorizedMemoryRequest<ConflictResolutionCommand>,
  ): Promise<ConflictResolutionResult> {
    if (
      request.authorization.allowed !== true ||
      request.action !== "merge" ||
      request.resourceKind !== "memory_entity" ||
      request.authorization.action !== request.action ||
      request.authorization.resourceKind !== request.resourceKind
    ) {
      throw new Error("conflict resolution requires merge authorization");
    }
    const idempotencyKey = [
      request.rootEntityId,
      request.branchRef,
      request.clientMutationId,
    ].join(":");
    const prior = this.resolutionIdempotency.get(idempotencyKey);
    if (prior !== undefined) {
      if (prior.fingerprint !== requestFingerprint(request)) {
        throw new Error(
          "resolution clientMutationId was already used for a different command",
        );
      }
      return clone(prior.result);
    }
    const conflicts = request.conflictIds.map((conflictId) => {
      const conflict = this.conflicts.find(
        (candidate) =>
          candidate.id === conflictId &&
          candidate.rootEntityId === request.rootEntityId &&
          candidate.targetBranchRef === request.branchRef,
      );
      if (conflict === undefined) {
        throw new Error(`conflict not found: ${conflictId}`);
      }
      if (conflict.status !== "unresolved") {
        throw new Error(`conflict already resolved: ${conflictId}`);
      }
      return conflict;
    });
    if (conflicts.length === 0) {
      throw new Error("at least one conflict is required");
    }
    if (
      request.resolutionKind === "manual_merge" &&
      (request.manualOperation === undefined ||
        request.manualAction === undefined ||
        request.manualResourceKind === undefined)
    ) {
      throw new Error("manual merge requires an explicit operation");
    }

    const applied: CloudCommitRecord[] = [];
    if (request.resolutionKind === "take_incoming") {
      const remoteCommitIds = [
        ...new Set(
          conflicts.flatMap(
            (conflict) => conflict.remoteConflictingCommitIds,
          ),
        ),
      ];
      for (const [index, targetCommitId] of remoteCommitIds.entries()) {
        const revertRequest: AuthorizedMemoryRequest<CloudMemoryWriteCommand> =
          {
            subject: clone(request.subject),
            rootEntityId: request.rootEntityId,
            branchRef: request.branchRef,
            action: "revert",
            resourceKind: "memory_entity",
            clientMutationId: `${request.clientMutationId}:revert:${index}`,
            ...(this.headCommitId(
              request.rootEntityId,
              request.branchRef,
            ) === undefined
              ? {}
              : {
                  expectedHeadCommitId: this.headCommitId(
                    request.rootEntityId,
                    request.branchRef,
                  ) as string,
                }),
            commit: {
              id: `${request.commit.id}:revert:${index}`,
              message: "Remove the remote conflicting effect",
            },
            operation: {
              kind: "revert_commit",
              id: `operation:${request.commit.id}:revert:${index}`,
              targetCommitId,
            },
            ...(request.provenance === undefined
              ? {}
              : { provenance: clone(request.provenance) }),
            authorization: {
              ...clone(request.authorization),
              action: "revert",
              resourceKind: "memory_entity",
            },
          };
        const reverted = await this.accept(
          revertRequest,
          conflictKeysForOperation(revertRequest.operation),
        );
        if (reverted.status !== "accepted") {
          throw new Error("remote conflict revert was not accepted");
        }
        const record = this.records.find(
          (candidate) => candidate.sequence === reverted.sequence,
        );
        if (record !== undefined) {
          applied.push(clone(record));
        }
      }
    }
    const mutations: Array<{
      operation: MemoryOperationInput;
      action: MemoryAction;
      resourceKind: MemoryObjectKind;
    }> =
      request.resolutionKind === "take_incoming"
        ? conflicts.map((conflict) => {
            const incoming = this.conflictedRequests.get(
              conflict.incomingCommitId,
            );
            if (incoming === undefined) {
              throw new Error("conflicted request not found");
            }
            return {
              operation: incoming.operation,
              action: incoming.action,
              resourceKind: incoming.resourceKind,
            };
          })
        : request.resolutionKind === "manual_merge"
          ? [
              {
                operation: request.manualOperation as MemoryOperationInput,
                action: request.manualAction as MemoryAction,
                resourceKind:
                  request.manualResourceKind as MemoryObjectKind,
              },
            ]
          : [];

    for (const [index, mutation] of mutations.entries()) {
      const suffix = `resolution-${request.commit.id}-${index}`;
      const applyRequest: AuthorizedMemoryRequest<CloudMemoryWriteCommand> = {
        subject: clone(request.subject),
        rootEntityId: request.rootEntityId,
        branchRef: request.branchRef,
        action: mutation.action,
        resourceKind: mutation.resourceKind,
        clientMutationId: `${request.clientMutationId}:apply:${index}`,
        ...(this.headCommitId(
          request.rootEntityId,
          request.branchRef,
        ) === undefined
          ? {}
          : {
              expectedHeadCommitId: this.headCommitId(
                request.rootEntityId,
                request.branchRef,
              ) as string,
            }),
        commit: {
          id: `${request.commit.id}:apply:${index}`,
          message: `Apply ${request.resolutionKind} conflict resolution`,
        },
        operation: operationWithResolutionIds(
          mutation.operation,
          suffix,
        ),
        ...(request.provenance === undefined
          ? {}
          : { provenance: clone(request.provenance) }),
        authorization: {
          ...clone(request.authorization),
          action: mutation.action,
          resourceKind: mutation.resourceKind,
        },
      };
      const result = await this.accept(
        applyRequest,
        conflictKeysForOperation(applyRequest.operation),
      );
      if (result.status !== "accepted") {
        throw new Error("resolution mutation was not accepted");
      }
      const record = this.records.find(
        (candidate) => candidate.sequence === result.sequence,
      );
      if (record !== undefined) {
        applied.push(clone(record));
      }
    }

    const resolvedIncomingCommitIds = conflicts.map(
      (conflict) => conflict.incomingCommitId,
    );
    const markerRequest: AuthorizedMemoryRequest<CloudMemoryWriteCommand> = {
      subject: clone(request.subject),
      rootEntityId: request.rootEntityId,
      branchRef: request.branchRef,
      action: "merge",
      resourceKind: "memory_entity",
      clientMutationId: request.clientMutationId,
      ...(this.headCommitId(
        request.rootEntityId,
        request.branchRef,
      ) === undefined
        ? {}
        : {
            expectedHeadCommitId: this.headCommitId(
              request.rootEntityId,
              request.branchRef,
            ) as string,
          }),
      commit: clone(request.commit),
      operation: {
        kind: "resolve_conflict",
        id: `operation:${request.commit.id}`,
        resolvedConflictIds: conflicts.map(({ id }) => id),
        resolvedIncomingCommitIds,
        resolutionKind: request.resolutionKind,
      },
      ...(request.provenance === undefined
        ? {}
        : { provenance: clone(request.provenance) }),
      authorization: clone(request.authorization),
    };
    const marker = await this.accept(
      markerRequest,
      conflictKeysForOperation(markerRequest.operation),
    );
    if (marker.status !== "accepted") {
      throw new Error("resolution marker was not accepted");
    }
    const resolution = this.records.find(
      (record) => record.sequence === marker.sequence,
    );
    if (resolution === undefined) {
      throw new Error("resolution record not found");
    }
    resolution.resolution = {
      resolvedConflictIds: conflicts.map(({ id }) => id),
      resolvedIncomingCommitIds,
      resolutionKind: request.resolutionKind,
    };
    for (const conflict of conflicts) {
      conflict.status = "resolved";
      conflict.resolvedByCommitId = resolution.commit.id;
    }
    const result = {
      sequence: resolution.sequence,
      resolution: clone(resolution),
      applied,
    };
    this.resolutionIdempotency.set(idempotencyKey, {
      fingerprint: requestFingerprint(request),
      result: clone(result),
    });
    return result;
  }

  private conflictingKeysSince(
    rootEntityId: string,
    branchRef: string,
    expectedHeadCommitId: string | undefined,
    currentHeadCommitId: string | undefined,
    incomingKeys: string[],
  ): string[] {
    if (expectedHeadCommitId === currentHeadCommitId) {
      return [];
    }
    const changed = new Set(
      this.acceptedRecordsSince(
        rootEntityId,
        branchRef,
        expectedHeadCommitId,
      )
        .flatMap((record) => record.conflictKeys),
    );
    return incomingKeys.filter((key) => changed.has(key));
  }

  private acceptedRecordsSince(
    rootEntityId: string,
    branchRef: string,
    expectedHeadCommitId: string | undefined,
  ): CloudCommitRecord[] {
    let baseSequence = 0;
    if (expectedHeadCommitId !== undefined) {
      const base = this.records.find(
        (record) =>
          record.commit.id === expectedHeadCommitId &&
          record.commit.rootEntityId === rootEntityId &&
          record.targetBranchRef === branchRef &&
          record.status === "accepted",
      );
      if (base === undefined) {
        throw new Error("expectedHeadCommitId is not in target history");
      }
      baseSequence = base.sequence;
    }
    return this.records.filter(
      (record) =>
        record.commit.rootEntityId === rootEntityId &&
        record.targetBranchRef === branchRef &&
        record.status === "accepted" &&
        record.sequence > baseSequence,
    );
  }

  private equivalentAcceptedRecordSince(
    request: AuthorizedMemoryRequest<CloudMemoryWriteCommand>,
    conflictingKeys: string[],
  ): CloudCommitRecord | undefined {
    let baseSequence = 0;
    if (request.expectedHeadCommitId !== undefined) {
      baseSequence =
        this.records.find(
          (record) =>
            record.commit.id === request.expectedHeadCommitId &&
            record.status === "accepted",
        )?.sequence ?? 0;
    }
    const incomingEffect = operationEffect(request.operation);
    return this.records.find(
      (record) =>
        record.status === "accepted" &&
        record.commit.rootEntityId === request.rootEntityId &&
        record.targetBranchRef === request.branchRef &&
        record.sequence > baseSequence &&
        conflictingKeys.every((key) =>
          record.conflictKeys.includes(key),
        ) &&
        record.operations.some(
          (operation) =>
            operationEffect(operation.input) === incomingEffect,
        ),
    );
  }

  private async accept(
    request: AuthorizedMemoryRequest<CloudMemoryWriteCommand>,
    conflictKeys: string[],
  ): Promise<CloudMemoryWriteResult> {
    const write = await this.core.execute(request);
    const sequence = this.sequence + 1;
    this.sequence = sequence;
    this.records.push({
      sequence,
      clientMutationId: request.clientMutationId,
      targetBranchRef: request.branchRef,
      storedBranchRef: request.branchRef,
      conflictKeys: [...conflictKeys],
      commit: clone(write.commit),
      operations: clone(write.operations),
      status: "accepted",
    });
    this.acceptedRequests.push({
      sequence,
      request: clone(request),
    });
    this.outbox.push({
      id: `outbox:${sequence}`,
      sequence,
      rootEntityId: request.rootEntityId,
      branchRef: request.branchRef,
      kind: "commit_accepted",
      commitId: write.commit.id,
    });
    return {
      status: "accepted",
      sequence,
      write,
    };
  }

  private async captureConflict(
    request: AuthorizedMemoryRequest<CloudMemoryWriteCommand>,
    remoteHeadCommitId: string | undefined,
    allKeys: string[],
    conflictingKeys: string[],
  ): Promise<CloudMemoryWriteResult> {
    if (remoteHeadCommitId === undefined) {
      throw new Error("conflict requires an existing remote head");
    }
    const sequence = this.sequence + 1;
    const conflictBranchRef = [
      "conflict",
      request.branchRef,
      sequence,
      request.commit.id,
    ].join("/");
    const targetView = this.core.readActiveView(
      request.rootEntityId,
      request.branchRef,
    );
    const conflictAuthority = new InMemoryMemoryAuthority(
      conflictSeedForOperation(
        targetView,
        conflictBranchRef,
        request.operation,
      ),
    );
    const conflictRequest = {
      ...clone(request),
      branchRef: conflictBranchRef,
      operation: operationForBranch(
        clone(request.operation),
        conflictBranchRef,
      ),
    };
    const incoming = await conflictAuthority.execute(conflictRequest);
    this.sequence = sequence;
    this.conflictAuthorities.set(conflictBranchRef, conflictAuthority);
    const remote = this.records.find(
      (record) => record.commit.id === remoteHeadCommitId,
    );
    if (remote === undefined) {
      throw new Error("remote head commit record not found");
    }
    const conflict: MemoryConflict = {
      id: `conflict:${sequence}`,
      rootEntityId: request.rootEntityId,
      targetBranchRef: request.branchRef,
      conflictBranchRef,
      ...(request.expectedHeadCommitId === undefined
        ? {}
        : { baseCommitId: request.expectedHeadCommitId }),
      remoteHeadCommitId,
      remoteConflictingCommitIds: this.acceptedRecordsSince(
        request.rootEntityId,
        request.branchRef,
        request.expectedHeadCommitId,
      )
        .filter((record) =>
          record.conflictKeys.some((key) =>
            conflictingKeys.includes(key),
          ),
        )
        .map((record) => record.commit.id),
      incomingCommitId: incoming.commit.id,
      conflictKeys: [...conflictingKeys],
      remoteActor: clone(remote.commit.actor),
      incomingActor: actorFrom(request),
      status: "unresolved",
      createdAt: incoming.commit.createdAt,
    };
    this.conflicts.push(conflict);
    this.conflictedRequests.set(incoming.commit.id, clone(request));
    this.records.push({
      sequence,
      clientMutationId: request.clientMutationId,
      targetBranchRef: request.branchRef,
      storedBranchRef: conflictBranchRef,
      conflictKeys: [...allKeys],
      commit: clone(incoming.commit),
      operations: clone(incoming.operations),
      status: "conflicted",
    });
    this.outbox.push({
      id: `outbox:${sequence}`,
      sequence,
      rootEntityId: request.rootEntityId,
      branchRef: request.branchRef,
      kind: "conflict_created",
      commitId: incoming.commit.id,
    });
    return {
      status: "conflict",
      sequence,
      conflict,
      incoming,
    };
  }
}
