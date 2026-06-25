import type {
  MemoryActor,
  MemoryCommit,
} from "../contracts/memory.ts";
import type {
  AuthorizedMemoryRequest,
  MemoryAdapter,
} from "../permission-router.ts";
import { InMemoryMemoryAuthority } from "./authority.ts";
import type {
  MemoryActiveView,
  MemoryAuthoritySeed,
  MemoryOperation,
  MemoryOperationInput,
  MemoryWriteCommand,
  MemoryWriteResult,
} from "./contracts.ts";

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
}

export interface MemoryConflict {
  id: string;
  rootEntityId: string;
  targetBranchRef: string;
  conflictBranchRef: string;
  baseCommitId?: string;
  remoteHeadCommitId: string;
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

interface AcceptedRequestRecord {
  sequence: number;
  request: AuthorizedMemoryRequest<CloudMemoryWriteCommand>;
}

interface IdempotencyRecord {
  fingerprint: string;
  result: CloudMemoryWriteResult;
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

function requestFingerprint(
  request: AuthorizedMemoryRequest<CloudMemoryWriteCommand>,
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
  }
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
    const changed = new Set(
      this.records
        .filter(
          (record) =>
            record.commit.rootEntityId === rootEntityId &&
            record.targetBranchRef === branchRef &&
            record.status === "accepted" &&
            record.sequence > baseSequence,
        )
        .flatMap((record) => record.conflictKeys),
    );
    return incomingKeys.filter((key) => changed.has(key));
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
      seedForBranch(targetView, conflictBranchRef),
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
      incomingCommitId: incoming.commit.id,
      conflictKeys: [...conflictingKeys],
      remoteActor: clone(remote.commit.actor),
      incomingActor: actorFrom(request),
      status: "unresolved",
      createdAt: incoming.commit.createdAt,
    };
    this.conflicts.push(conflict);
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
