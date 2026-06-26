import type {
  PermissionRouteResult,
  PermissionRouter,
} from "../permission-router.ts";
import { InMemoryMemoryAuthority } from "../memory/authority.ts";
import {
  conflictKeysForOperation,
  type CloudCommitRecord,
  type CloudMemoryWriteCommand,
  type CloudMemoryWriteResult,
} from "../history/cloud-authority.ts";
import type {
  MemoryActiveView,
  MemoryAuthoritySeed,
} from "../memory/contracts.ts";
import type { MemoryOperationInput } from "../contracts/history.ts";
import {
  InMemoryAuthorizedQuerySource,
  type MemoryQuerySource,
  type RetrievalOrigin,
} from "../memory/retrieval.ts";
import type {
  LocalAuthorizedViewStore,
} from "./working-replica.ts";

export type PendingOperationStatus =
  | "pending"
  | "pushed"
  | "conflicted"
  | "resolved"
  | "rejected"
  | "superseded";

export interface PendingOperationProvenance {
  sessionId: string;
  ownerUserId: string;
  delegationId?: string;
  parentAgentId?: string;
}

interface PendingBaseFragment extends MemoryAuthoritySeed {}

export interface PendingOperationRecord {
  id: string;
  localSequence: number;
  baseCommitId?: string;
  clientMutationId: string;
  conflictKeys: string[];
  command: CloudMemoryWriteCommand;
  provenance: PendingOperationProvenance;
  status: PendingOperationStatus;
  cloudCommitId?: string;
  cloudIncomingCommitId?: string;
  cloudConflictId?: string;
  conflictBranchRef?: string;
  remoteCommitIds: string[];
  baseFragment: PendingBaseFragment;
}

export interface PendingOverlayState {
  nextSequence: number;
  records: PendingOperationRecord[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isOverlayActive(status: PendingOperationStatus): boolean {
  return (
    status === "pending" ||
    status === "pushed" ||
    status === "conflicted"
  );
}

function mergeMissing<T extends { id: string }>(
  current: T[],
  additions: T[] | undefined,
): T[] {
  const map = new Map(current.map((value) => [value.id, clone(value)]));
  for (const addition of additions ?? []) {
    if (!map.has(addition.id)) {
      map.set(addition.id, clone(addition));
    }
  }
  return [...map.values()];
}

function relationKeys(
  relation: MemoryActiveView["relations"][number],
): string[] {
  return conflictKeysForOperation({
    kind: "create_relation",
    id: `key:${relation.id}`,
    relation: {
      ...relation,
    },
  });
}

function extractBaseFragment(
  view: MemoryActiveView,
  keys: string[],
): PendingBaseFragment {
  const entityIds = new Set(
    keys.flatMap((key) => {
      if (key.startsWith("entity:")) return [key.slice("entity:".length)];
      if (key.startsWith("entity-branch:")) {
        return [key.split(":")[1] ?? ""];
      }
      return [];
    }),
  );
  const resourceIds = new Set(
    keys
      .filter((key) => key.startsWith("resource:"))
      .map((key) => key.slice("resource:".length)),
  );
  const chunkIds = new Set(
    keys
      .filter((key) => key.startsWith("resource-chunk:"))
      .map((key) => key.slice("resource-chunk:".length)),
  );
  const relationIds = new Set(
    keys
      .filter(
        (key) =>
          key.startsWith("relation:") &&
          key.split(":").length === 2,
      )
      .map((key) => key.slice("relation:".length)),
  );
  return {
    entities: view.entities.filter((entity) => entityIds.has(entity.id)),
    entityBranches: view.entityBranches.filter((branch) =>
      entityIds.has(branch.entityId),
    ),
    relations: view.relations.filter(
      (relation) =>
        relationIds.has(relation.id) ||
        entityIds.has(relation.sourceId) ||
        entityIds.has(relation.targetId) ||
        resourceIds.has(relation.sourceId) ||
        resourceIds.has(relation.targetId) ||
        chunkIds.has(relation.sourceId) ||
        chunkIds.has(relation.targetId),
    ),
    resources: view.resources.filter((resource) =>
      resourceIds.has(resource.id),
    ),
    resourceChunks: view.resourceChunks.filter(
      (chunk) =>
        chunkIds.has(chunk.id) || resourceIds.has(chunk.resourceId),
    ),
  };
}

function rehydrate(
  view: MemoryActiveView,
  fragments: PendingBaseFragment[],
): MemoryActiveView {
  let result = clone(view);
  for (const fragment of fragments) {
    result = {
      ...result,
      entities: mergeMissing(result.entities, fragment.entities),
      entityBranches: mergeMissing(
        result.entityBranches,
        fragment.entityBranches,
      ),
      relations: mergeMissing(result.relations, fragment.relations),
      resources: mergeMissing(result.resources, fragment.resources),
      resourceChunks: mergeMissing(
        result.resourceChunks,
        fragment.resourceChunks,
      ),
    };
  }
  return result;
}

function removeShadowed(
  view: MemoryActiveView,
  operation: MemoryOperationInput,
): MemoryActiveView {
  const keys = new Set(conflictKeysForOperation(operation));
  if (operation.kind === "create_entity") {
    return {
      ...view,
      entities: view.entities.filter(
        (entity) => entity.id !== operation.entity.id,
      ),
      entityBranches: view.entityBranches.filter(
        (branch) => branch.entityId !== operation.entity.id,
      ),
      relations: view.relations.filter(
        (relation) =>
          relation.sourceId !== operation.entity.id &&
          relation.targetId !== operation.entity.id,
      ),
    };
  }
  if (operation.kind === "create_resource") {
    return {
      ...view,
      resources: view.resources.filter(
        (resource) => resource.id !== operation.resource.id,
      ),
      resourceChunks: view.resourceChunks.filter(
        (chunk) => chunk.resourceId !== operation.resource.id,
      ),
    };
  }
  if (operation.kind === "create_resource_chunk") {
    return {
      ...view,
      resourceChunks: view.resourceChunks.filter(
        (chunk) => chunk.id !== operation.chunk.id,
      ),
    };
  }
  if (
    operation.kind === "create_relation" ||
    operation.kind === "replace_relation"
  ) {
    return {
      ...view,
      relations: view.relations.filter(
        (relation) =>
          !relationKeys(relation).some((key) => keys.has(key)),
      ),
    };
  }
  if (operation.kind === "create_entity_branch") {
    return {
      ...view,
      entityBranches: view.entityBranches.filter(
        (branch) => branch.id !== operation.branch.id,
      ),
    };
  }
  return view;
}

function authorizedCommand(command: CloudMemoryWriteCommand) {
  return {
    ...clone(command),
    authorization: {
      allowed: true as const,
      reason: "local_pending",
      subjectId:
        command.subject.kind === "user"
          ? command.subject.userId
          : command.subject.agentId,
      subjectKind: command.subject.kind,
      rootEntityId: command.rootEntityId,
      action: command.action,
      resourceKind: command.resourceKind,
      matchedRoles: [],
      missingActions: [],
      constraints: {},
    },
  };
}

export class InMemoryPendingOverlay {
  private state: PendingOverlayState;
  private readonly localView: LocalAuthorizedViewStore;

  constructor(
    localView: LocalAuthorizedViewStore,
    initialState: PendingOverlayState = {
      nextSequence: 1,
      records: [],
    },
  ) {
    this.localView = localView;
    this.state = clone(initialState);
  }

  inspect(): PendingOverlayState {
    return clone(this.state);
  }

  async stage(
    command: CloudMemoryWriteCommand,
    provenance: PendingOperationProvenance,
  ): Promise<PendingOperationRecord> {
    const current = await this.materialize();
    if (
      current.rootEntityId !== command.rootEntityId ||
      current.branchRef !== command.branchRef
    ) {
      throw new Error("pending operation local view mismatch");
    }
    const record: PendingOperationRecord = {
      id: `pending:${this.state.nextSequence}`,
      localSequence: this.state.nextSequence,
      ...(command.expectedHeadCommitId === undefined
        ? {}
        : { baseCommitId: command.expectedHeadCommitId }),
      clientMutationId: command.clientMutationId,
      conflictKeys: conflictKeysForOperation(command.operation),
      command: {
        ...clone(command),
        provenance: {
          sessionId: provenance.sessionId,
          ownerUserId: provenance.ownerUserId,
          ...(provenance.delegationId === undefined
            ? {}
            : { delegationId: provenance.delegationId }),
          ...(provenance.parentAgentId === undefined
            ? {}
            : { parentAgentId: provenance.parentAgentId }),
        },
      },
      provenance: clone(provenance),
      status: "pending",
      remoteCommitIds: [],
      baseFragment: extractBaseFragment(
        current,
        conflictKeysForOperation(command.operation),
      ),
    };
    const candidate = {
      nextSequence: this.state.nextSequence + 1,
      records: [...this.state.records, record],
    };
    await this.materialize(candidate);
    this.state = candidate;
    this.localView.replacePendingOperations(this.state.records);
    return clone(record);
  }

  async materialize(
    state: PendingOverlayState = this.state,
  ): Promise<MemoryActiveView> {
    const base = this.localView.readView(
      this.localView.inspect().identity?.rootEntityId ?? "",
      this.localView.inspect().identity?.branchRef ?? "",
    );
    const active = state.records.filter((record) =>
      isOverlayActive(record.status),
    );
    let prepared = rehydrate(
      base,
      active.map((record) => record.baseFragment),
    );
    for (const record of active) {
      prepared = removeShadowed(prepared, record.command.operation);
    }
    const authority = new InMemoryMemoryAuthority({
      entities: prepared.entities,
      entityBranches: prepared.entityBranches,
      relations: prepared.relations,
      resources: prepared.resources,
      resourceChunks: prepared.resourceChunks,
    });
    for (const record of active) {
      await authority.execute(authorizedCommand(record.command));
    }
    return authority.readActiveView(base.rootEntityId, base.branchRef);
  }

  async push(
    router: PermissionRouter<
      CloudMemoryWriteResult,
      CloudMemoryWriteCommand
    >,
  ): Promise<void> {
    for (const record of this.state.records) {
      if (record.status !== "pending") continue;
      const result = await router.execute(record.command);
      if (!("value" in result)) {
        throw new Error(`pending push denied: ${result.decision.reason}`);
      }
      if (result.value.status === "accepted") {
        record.status = "pushed";
        record.cloudCommitId = result.value.write.commit.id;
      } else {
        record.status = "conflicted";
        record.cloudIncomingCommitId =
          result.value.incoming.commit.id;
        record.cloudConflictId = result.value.conflict.id;
        record.conflictBranchRef =
          result.value.conflict.conflictBranchRef;
      }
    }
    this.localView.replacePendingOperations(this.state.records);
  }

  reconcile(records: CloudCommitRecord[]): void {
    for (const pending of this.state.records) {
      if (!isOverlayActive(pending.status)) continue;
      const resolution = records.find(
        (record) =>
          pending.cloudIncomingCommitId !== undefined &&
          record.resolution?.resolvedIncomingCommitIds.includes(
            pending.cloudIncomingCommitId,
          ) === true,
      );
      if (resolution?.resolution !== undefined) {
        pending.status =
          resolution.resolution.resolutionKind === "take_incoming"
            ? "resolved"
            : resolution.resolution.resolutionKind === "keep_target"
              ? "rejected"
              : "superseded";
        continue;
      }
      const accepted = records.find(
        (record) =>
          record.status === "accepted" &&
          record.clientMutationId === pending.clientMutationId,
      );
      if (accepted !== undefined) {
        pending.status = "resolved";
        pending.cloudCommitId = accepted.commit.id;
        continue;
      }
      for (const remote of records) {
        if (
          remote.status === "accepted" &&
          remote.clientMutationId !== pending.clientMutationId &&
          remote.conflictKeys.some((key) =>
            pending.conflictKeys.includes(key),
          )
        ) {
          pending.status = "conflicted";
          if (!pending.remoteCommitIds.includes(remote.commit.id)) {
            pending.remoteCommitIds.push(remote.commit.id);
          }
        }
      }
    }
    this.localView.replacePendingOperations(this.state.records);
  }

  querySource(): MemoryQuerySource {
    return new InMemoryAuthorizedQuerySource(
      () => this.materialize(),
      "local_snapshot",
      (kind, id): RetrievalOrigin =>
        this.isPendingObject(kind, id)
          ? "local_pending"
          : "local_snapshot",
    );
  }

  private isPendingObject(
    kind: "entity" | "relation" | "resource_chunk",
    id: string,
  ): boolean {
    const keys = this.state.records
      .filter((record) => isOverlayActive(record.status))
      .flatMap((record) => record.conflictKeys);
    if (kind === "entity") {
      return (
        keys.includes(`entity:${id}`) ||
        keys.some((key) => key.startsWith(`entity-branch:${id}:`))
      );
    }
    return keys.includes(
      kind === "relation"
        ? `relation:${id}`
        : `resource-chunk:${id}`,
    );
  }
}

export class PendingOverlaySynchronizer {
  private readonly synchronize: () => Promise<
    PermissionRouteResult<unknown>
  >;
  private readonly cloudRecords: (
    afterSequence: number,
  ) => CloudCommitRecord[];
  private readonly localView: LocalAuthorizedViewStore;
  private readonly pending: InMemoryPendingOverlay;

  constructor(
    synchronize: () => Promise<
      PermissionRouteResult<unknown>
    >,
    cloudRecords: (
      afterSequence: number,
    ) => CloudCommitRecord[],
    localView: LocalAuthorizedViewStore,
    pending: InMemoryPendingOverlay,
  ) {
    this.synchronize = synchronize;
    this.cloudRecords = cloudRecords;
    this.localView = localView;
    this.pending = pending;
  }

  async sync(): Promise<PermissionRouteResult<unknown>> {
    const before =
      this.localView.inspect().identity?.commitWatermark ?? 0;
    const result = await this.synchronize();
    if ("value" in result) {
      this.pending.reconcile(this.cloudRecords(before));
    }
    return result;
  }
}
