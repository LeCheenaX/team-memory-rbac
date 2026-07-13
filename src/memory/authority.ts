import type {
  MemoryBranch,
  MemoryCommit,
  MemoryOperation,
  MemoryOperationInput,
  HistoryWriteCommand,
  HistoryWriteResult,
  ResourceRevision,
} from "../contracts/history.ts";
import type {
  MemoryEntity,
  MemoryEntityBranch,
  MemoryRelation,
  Resource,
  ResourceChunk,
} from "../contracts/memory.ts";
import {
  assertEntityExtraInfo,
  assertMemoryModelInvariants,
} from "../contracts/memory.ts";
import type { MemoryAdapter, AuthorizedMemoryRequest } from "../permission-router.ts";
import type {
  MemoryActiveView,
  MemoryAuthoritySeed,
} from "./contracts.ts";

type MemoryWriteCommand = HistoryWriteCommand;
type MemoryWriteResult = HistoryWriteResult;

export interface InMemoryMemoryAuthorityOptions {
  now?: () => Date;
}

function actorFrom(
  request: MemoryWriteCommand,
): MemoryOperation["actor"] {
  return request.subject.kind === "user"
    ? { kind: "user", id: request.subject.userId }
    : { kind: "agent", id: request.subject.agentId };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function requestOperations(
  request: MemoryWriteCommand,
): MemoryOperationInput[] {
  return request.operations ?? [request.operation];
}

/** @deprecated Combined History + Memory reference implementation. */
export class InMemoryMemoryAuthority
  implements MemoryAdapter<MemoryWriteResult, MemoryWriteCommand>
{
  private readonly seed: MemoryAuthoritySeed;
  private readonly commits: MemoryCommit[] = [];
  private readonly operations: MemoryOperation[] = [];
  private readonly now: () => Date;

  constructor(
    seed: MemoryAuthoritySeed = {},
    options: InMemoryMemoryAuthorityOptions = {},
  ) {
    assertMemoryModelInvariants(seed);
    this.seed = clone(seed);
    this.now = options.now ?? (() => new Date());
  }

  async execute(
    request: AuthorizedMemoryRequest<MemoryWriteCommand>,
  ): Promise<MemoryWriteResult> {
    this.assertAuthorizedCommand(request);
    const createdAt = this.now().toISOString();
    const branchState = this.ensureBranch(
      request.rootEntityId,
      request.branchRef,
      createdAt,
    );
    const branch = branchState.branch;
    const previousHeadCommitId = branch.headCommitId;
    const expandedInputs = requestOperations(request).flatMap((input) =>
      this.expandOperation(input),
    );
    const newOperations = expandedInputs.map((input) =>
      this.createOperation(request, input, createdAt),
    );
    const commit: MemoryCommit = {
      id: request.commit.id,
      rootEntityId: request.rootEntityId,
      branchRef: request.branchRef,
      ...(branch.headCommitId === undefined
        ? {}
        : { parentCommitId: branch.headCommitId }),
      operationIds: newOperations.map((operation) => operation.id),
      actor: actorFrom(request),
      ...(request.commit.message === undefined
        ? {}
        : { message: request.commit.message }),
      createdAt,
    };

    this.assertUniqueIds(commit, newOperations);
    this.commits.push(commit);
    this.operations.push(...newOperations);
    branch.headCommitId = commit.id;
    branch.updatedAt = createdAt;

    try {
      // Force invariant validation at the write seam before acknowledging.
      this.readActiveView(request.rootEntityId, request.branchRef);
    } catch (error) {
      this.commits.pop();
      this.operations.splice(
        this.operations.length - newOperations.length,
        newOperations.length,
      );
      if (previousHeadCommitId === undefined) {
        delete branch.headCommitId;
      } else {
        branch.headCommitId = previousHeadCommitId;
      }
      if (branchState.created) {
        const branches = this.seed.branches ?? [];
        const index = branches.indexOf(branch);
        if (index >= 0) {
          branches.splice(index, 1);
        }
      }
      throw error;
    }

    return {
      commit: clone(commit),
      operations: clone(newOperations),
    };
  }

  readActiveView(
    rootEntityId: string,
    branchRef: string,
  ): MemoryActiveView {
    const entities = new Map(
      (this.seed.entities ?? [])
        .filter(
          (entity) =>
            (entity.rootEntityId ?? entity.id) === rootEntityId,
        )
        .map((entity) => [entity.id, clone(entity)]),
    );
    const entityBranches = new Map(
      (this.seed.entityBranches ?? [])
        .filter(
          (branch) =>
            branch.rootEntityId === rootEntityId &&
            branch.branchRef === branchRef,
        )
        .map((branch) => [branch.id, clone(branch)]),
    );
    const relations = new Map(
      (this.seed.relations ?? [])
        .filter(
          (relation) =>
            relation.rootEntityId === rootEntityId &&
            relation.branchRef === branchRef,
        )
        .map((relation) => [relation.id, clone(relation)]),
    );
    const resources = new Map(
      (this.seed.resources ?? [])
        .filter((resource) => resource.rootEntityId === rootEntityId)
        .map((resource) => [resource.id, clone(resource)]),
    );
    const resourceChunks = new Map(
      (this.seed.resourceChunks ?? [])
        .filter((chunk) => chunk.rootEntityId === rootEntityId)
        .map((chunk) => [chunk.id, clone(chunk)]),
    );

    const revertedCommits = new Set(
      this.operations
        .filter(
          (operation) =>
            operation.rootEntityId === rootEntityId &&
            operation.branchRef === branchRef &&
            operation.kind === "revert_commit",
        )
        .map((operation) => {
          if (operation.input.kind !== "revert_commit") {
            throw new Error("invalid revert operation");
          }
          return operation.input.targetCommitId;
        }),
    );

    for (const operation of this.operations) {
      if (
        operation.rootEntityId !== rootEntityId ||
        operation.branchRef !== branchRef ||
        revertedCommits.has(operation.commitId) ||
        operation.kind === "revert_commit"
      ) {
        continue;
      }
      this.applyOperation(
        operation,
        entities,
        entityBranches,
        relations,
        resources,
        resourceChunks,
      );
    }

    const view: MemoryActiveView = {
      rootEntityId,
      branchRef,
      entities: [...entities.values()].filter(
        (entity) => entity.status !== "tombstoned",
      ),
      entityBranches: [...entityBranches.values()].filter(
        (branch) => branch.status !== "tombstoned",
      ),
      relations: [...relations.values()].filter(
        (relation) => relation.status !== "tombstoned",
      ),
      resources: [...resources.values()].filter(
        (resource) => resource.status !== "tombstoned",
      ),
      resourceChunks: [...resourceChunks.values()].filter(
        (chunk) => chunk.status !== "tombstoned",
      ),
    };

    assertMemoryModelInvariants(view);
    return clone(view);
  }

  listCommits(
    rootEntityId: string,
    branchRef: string,
  ): MemoryCommit[] {
    return clone(
      this.commits.filter(
        (commit) =>
          commit.rootEntityId === rootEntityId &&
          commit.branchRef === branchRef,
      ),
    );
  }

  listBranches(rootEntityId: string): MemoryBranch[] {
    return clone(
      (this.seed.branches ?? []).filter(
        (branch) => branch.rootEntityId === rootEntityId,
      ),
    );
  }

  listOperations(
    rootEntityId: string,
    branchRef: string,
  ): MemoryOperation[] {
    return clone(
      this.operations.filter(
        (operation) =>
          operation.rootEntityId === rootEntityId &&
          operation.branchRef === branchRef,
      ),
    );
  }

  listResourceRevisions(
    rootEntityId: string,
    branchRef: string,
  ): ResourceRevision[] {
    const revisions = (this.seed.resourceRevisions ?? []).filter(
      (revision) => revision.rootEntityId === rootEntityId,
    );
    for (const operation of this.listOperations(rootEntityId, branchRef)) {
      if (operation.input.kind === "create_resource") {
        revisions.push({
          id: operation.input.revisionId,
          resourceId: operation.input.resource.id,
          rootEntityId,
          commitId: operation.commitId,
          contentHash: operation.input.resource.contentHash,
          ...(operation.input.resource.metadata === undefined
            ? {}
            : { metadata: operation.input.resource.metadata }),
          createdAt: operation.createdAt,
        });
      }
      if (operation.input.kind === "revise_resource") {
        const input = operation.input;
        const previous = revisions
          .filter(
            (revision) =>
              revision.resourceId === input.resourceId,
          )
          .at(-1);
        revisions.push({
          id: input.revisionId,
          resourceId: input.resourceId,
          rootEntityId,
          commitId: operation.commitId,
          ...(previous === undefined
            ? {}
            : { parentRevisionId: previous.id }),
          contentHash: input.contentHash,
          ...(input.metadata === undefined
            ? {}
            : { metadata: input.metadata }),
          createdAt: operation.createdAt,
        });
      }
    }
    return clone(revisions);
  }

  private assertAuthorizedCommand(
    request: AuthorizedMemoryRequest<MemoryWriteCommand>,
  ): void {
    if (
      request.authorization.allowed !== true ||
      request.authorization.rootEntityId !== request.rootEntityId ||
      request.authorization.action !== request.action ||
      request.authorization.resourceKind !== request.resourceKind
    ) {
      throw new Error("memory write requires a matching authorization");
    }
    if (request.branchRef.length === 0) {
      throw new Error("branchRef must be a non-empty string");
    }
    const operations = requestOperations(request);
    for (const operation of operations) {
      this.assertOperationMatchesPermission(request, operation);
      this.assertOperationRoot(operation, request.rootEntityId);
    }
    let activeView: MemoryActiveView | undefined;
    if (operations.some((operation) =>
      !(
        operation.kind === "create_entity" &&
        operation.entity.rootEntityId === null
      ) &&
      operation.kind !== "revert_commit"
    )) {
      activeView = this.readActiveView(
        request.rootEntityId,
        request.branchRef,
      );
      const root = activeView.entities.find(
        (entity) =>
          entity.id === request.rootEntityId &&
          entity.rootEntityId === null,
      );
      if (root === undefined) {
        throw new Error("active RootEntity not found");
      }
    }
    const pendingEntityIds = new Set(
      operations
        .filter((operation) => operation.kind === "create_entity")
        .map((operation) => operation.entity.id),
    );
    for (const operation of operations) {
      this.assertMutationTargetExists(operation, activeView);
      this.assertRevisionIdAvailable(operation);
      if (
        operation.kind === "create_entity_branch" &&
        operation.branch.branchRef !== request.branchRef
      ) {
        throw new Error("entity branchRef must match commit branchRef");
      }
      if (
        operation.kind === "create_entity_branch" &&
        activeView !== undefined &&
        !activeView.entities.some(({ id }) => id === operation.branch.entityId) &&
        !pendingEntityIds.has(operation.branch.entityId)
      ) {
        throw new Error(`entity not found: ${operation.branch.entityId}`);
      }
      if (
        operation.kind === "create_relation" &&
        operation.relation.branchRef !== request.branchRef
      ) {
        throw new Error("relation branchRef must match commit branchRef");
      }
      if (
        operation.kind === "replace_relation" &&
        operation.replacement.branchRef !== request.branchRef
      ) {
        throw new Error("relation branchRef must match commit branchRef");
      }
      if (operation.kind === "revert_commit") {
        const input = operation;
        const target = this.commits.find(
          (commit) =>
            commit.id === input.targetCommitId &&
            commit.rootEntityId === request.rootEntityId &&
            commit.branchRef === request.branchRef,
        );
        if (target === undefined) {
          throw new Error("revert target commit not found");
        }
        if (
          target.operationIds.some(
            (operationId) =>
              this.operations.find(({ id }) => id === operationId)?.kind ===
              "revert_commit",
          )
        ) {
          throw new Error("reverting a revert commit is not supported");
        }
      }
    }
  }

  private assertMutationTargetExists(
    input: MemoryOperationInput,
    view: MemoryActiveView | undefined,
  ): void {
    if (view === undefined) {
      return;
    }
    if (input.kind === "replace_relation") {
      if (
        !view.relations.some(
          (relation) => relation.id === input.previousRelationId,
        )
      ) {
        throw new Error(
          `relation not found: ${input.previousRelationId}`,
        );
      }
      return;
    }
    if (input.kind === "update_entity") {
      if (!view.entities.some(({ id }) => id === input.targetId)) {
        throw new Error(`entity not found: ${input.targetId}`);
      }
      return;
    }
    if (input.kind === "update_entity_branch_metadata") {
      if (!view.entityBranches.some(({ id }) => id === input.targetId)) {
        throw new Error(`entity branch not found: ${input.targetId}`);
      }
      return;
    }
    if (input.kind === "tombstone_resource") {
      if (!view.resources.some(({ id }) => id === input.targetId)) {
        throw new Error(`resource not found: ${input.targetId}`);
      }
      return;
    }
    if (input.kind === "tombstone_entity") {
      if (!view.entities.some(({ id }) => id === input.targetId)) {
        throw new Error(`entity not found: ${input.targetId}`);
      }
      return;
    }
    if (input.kind === "tombstone_entity_branch") {
      if (
        !view.entityBranches.some(({ id }) => id === input.targetId)
      ) {
        throw new Error(`entity branch not found: ${input.targetId}`);
      }
      return;
    }
    if (
      input.kind === "tombstone_relation" &&
      !view.relations.some(({ id }) => id === input.targetId)
    ) {
      throw new Error(`relation not found: ${input.targetId}`);
    }
  }

  private assertRevisionIdAvailable(
    input: MemoryOperationInput,
  ): void {
    const revisionId =
      input.kind === "create_resource" ||
      input.kind === "revise_resource"
        ? input.revisionId
        : undefined;
    if (revisionId === undefined) {
      return;
    }
    const used =
      (this.seed.resourceRevisions ?? []).some(
        ({ id }) => id === revisionId,
      ) ||
      this.operations.some(
        ({ input: existing }) =>
          (existing.kind === "create_resource" ||
            existing.kind === "revise_resource") &&
          existing.revisionId === revisionId,
      );
    if (used) {
      throw new Error(`duplicate resource revision id: ${revisionId}`);
    }
  }

  private assertOperationMatchesPermission(
    request: MemoryWriteCommand,
    operation: MemoryOperationInput,
  ): void {
    if (
      operation.kind === "create_entity" &&
      operation.entity.rootEntityId === null
    ) {
      if (
        request.action !== "create_root_entity" ||
        request.resourceKind !== "memory_entity"
      ) {
        throw new Error(
          "create_entity requires create_root_entity:memory_entity",
        );
      }
      return;
    }
    if (
      operation.kind === "tombstone_entity" &&
      operation.targetId === request.rootEntityId
    ) {
      if (
        request.action !== "delete_root_entity" ||
        request.resourceKind !== "memory_entity"
      ) {
        throw new Error(
          "tombstone_entity requires delete_root_entity:memory_entity",
        );
      }
      return;
    }

    if (
      request.action === "commit" &&
      request.resourceKind === "memory_entity" &&
      (
        operation.kind === "create_entity" ||
        operation.kind === "update_entity" ||
        operation.kind === "create_entity_branch" ||
        operation.kind === "update_entity_branch_metadata" ||
        operation.kind === "create_resource" ||
        operation.kind === "create_resource_chunk" ||
        operation.kind === "create_relation" ||
        operation.kind === "replace_relation"
      )
    ) {
      return;
    }

    const expected = {
      create_entity: ["write_entity", "memory_entity"],
      update_entity: ["write_entity", "memory_entity"],
      create_entity_branch: [
        "write_entity_branch",
        "memory_entity_branch",
      ],
      update_entity_branch_metadata: [
        "write_entity_branch",
        "memory_entity_branch",
      ],
      create_relation: ["write_relation", "memory_relation"],
      create_resource: ["import_resource", "resource"],
      create_resource_chunk: [
        "write_resource_chunk",
        "resource_chunk",
      ],
      revise_resource: ["import_resource", "resource"],
      replace_relation: ["write_relation", "memory_relation"],
      tombstone_resource: ["tombstone_resource", "resource"],
      tombstone_entity: ["tombstone_entity", "memory_entity"],
      tombstone_entity_branch: [
        "tombstone_entity_branch",
        "memory_entity_branch",
      ],
      tombstone_relation: [
        "tombstone_relation",
        "memory_relation",
      ],
      revert_commit: ["revert", "memory_entity"],
      resolve_conflict: ["merge", "memory_entity"],
    } as const;
    const [action, resourceKind] = expected[operation.kind];
    if (
      request.action !== action ||
      request.resourceKind !== resourceKind
    ) {
      throw new Error(
        `${operation.kind} requires ${action}:${resourceKind}`,
      );
    }
  }

  private assertOperationRoot(
    input: MemoryOperationInput,
    rootEntityId: string,
  ): void {
    const payloadRoot =
      input.kind === "create_entity"
        ? input.entity.rootEntityId ?? input.entity.id
        : input.kind === "update_entity"
          ? rootEntityId
        : input.kind === "create_entity_branch"
          ? input.branch.rootEntityId
          : input.kind === "update_entity_branch_metadata"
            ? rootEntityId
            : input.kind === "create_relation"
              ? input.relation.rootEntityId
              : input.kind === "create_resource"
                ? input.resource.rootEntityId
                : input.kind === "create_resource_chunk"
                  ? input.chunk.rootEntityId
                  : input.kind === "replace_relation"
                    ? input.replacement.rootEntityId
                    : rootEntityId;

    if (payloadRoot !== rootEntityId) {
      throw new Error(
        "operation rootEntityId must match authorization",
      );
    }
  }

  private ensureBranch(
    rootEntityId: string,
    branchRef: string,
    createdAt: string,
  ): { branch: MemoryBranch; created: boolean } {
    const existing = (this.seed.branches ?? []).find(
      (branch) =>
        branch.rootEntityId === rootEntityId &&
        branch.branchRef === branchRef,
    );
    if (existing !== undefined) {
      return { branch: existing, created: false };
    }
    const branch: MemoryBranch = {
      id: `branch:${rootEntityId}:${branchRef}`,
      rootEntityId,
      branchRef,
      status: "active",
      createdAt,
      updatedAt: createdAt,
    };
    (this.seed.branches ??= []).push(branch);
    return { branch, created: true };
  }

  private expandOperation(
    input: MemoryOperationInput,
  ): MemoryOperationInput[] {
    if (input.kind !== "replace_relation") {
      return [input];
    }
    return [
      {
        kind: "tombstone_relation",
        id: input.id,
        targetId: input.previousRelationId,
      },
      {
        kind: "create_relation",
        id: input.replacementOperationId,
        relation: input.replacement,
      },
    ];
  }

  private createOperation(
    request: MemoryWriteCommand,
    input: MemoryOperationInput,
    createdAt: string,
  ): MemoryOperation {
    return {
      id: input.id,
      rootEntityId: request.rootEntityId,
      branchRef: request.branchRef,
      commitId: request.commit.id,
      kind: input.kind,
      actor: actorFrom(request),
      ...(request.provenance === undefined
        ? {}
        : { provenance: clone(request.provenance) }),
      input: clone(input),
      createdAt,
    };
  }

  private assertUniqueIds(
    commit: MemoryCommit,
    operations: MemoryOperation[],
  ): void {
    if (this.commits.some((existing) => existing.id === commit.id)) {
      throw new Error(`duplicate commit id: ${commit.id}`);
    }
    const operationIds = new Set(this.operations.map(({ id }) => id));
    for (const operation of operations) {
      if (operationIds.has(operation.id)) {
        throw new Error(`duplicate operation id: ${operation.id}`);
      }
      operationIds.add(operation.id);
    }
  }

  private applyOperation(
    operation: MemoryOperation,
    entities: Map<string, MemoryEntity>,
    entityBranches: Map<string, MemoryEntityBranch>,
    relations: Map<string, MemoryRelation>,
    resources: Map<string, Resource>,
    resourceChunks: Map<string, ResourceChunk>,
  ): void {
    const input = operation.input;
    switch (input.kind) {
      case "create_entity": {
        if (entities.has(input.entity.id)) {
          throw new Error(`entity already exists: ${input.entity.id}`);
        }
        entities.set(input.entity.id, clone(input.entity));
        return;
      }
      case "update_entity": {
        if (!entities.has(input.targetId)) {
          throw new Error(`entity not found: ${input.targetId}`);
        }
        entities.set(input.targetId, clone(input.entity));
        return;
      }
      case "create_entity_branch": {
        if (entityBranches.has(input.branch.id)) {
          throw new Error(
            `entity branch already exists: ${input.branch.id}`,
          );
        }
        if (!entities.has(input.branch.entityId)) {
          throw new Error(`entity not found: ${input.branch.entityId}`);
        }
        if (input.branch.extraInfo !== undefined) {
          assertEntityExtraInfo(input.branch.extraInfo);
        }
        entityBranches.set(input.branch.id, {
          ...clone(input.branch),
          status: input.branch.status ?? "active",
        });
        const entity = entities.get(input.branch.entityId);
        if (entity !== undefined) {
          entity.currentBranchId = input.branch.id;
          entity.updatedAt = operation.createdAt;
        }
        return;
      }
      case "update_entity_branch_metadata": {
        if (!entityBranches.has(input.targetId)) {
          throw new Error(`entity branch not found: ${input.targetId}`);
        }
        if (input.branch.extraInfo !== undefined) {
          assertEntityExtraInfo(input.branch.extraInfo);
        }
        entityBranches.set(input.targetId, clone(input.branch));
        return;
      }
      case "create_relation": {
        if (relations.has(input.relation.id)) {
          throw new Error(
            `relation already exists: ${input.relation.id}`,
          );
        }
        this.assertRelationEndpointExists(
          input.relation.sourceKind,
          input.relation.sourceId,
          entities,
          entityBranches,
          resources,
          resourceChunks,
        );
        this.assertRelationEndpointExists(
          input.relation.targetKind,
          input.relation.targetId,
          entities,
          entityBranches,
          resources,
          resourceChunks,
        );
        relations.set(input.relation.id, {
          ...clone(input.relation),
        });
        return;
      }
      case "create_resource": {
        if (resources.has(input.resource.id)) {
          throw new Error(
            `resource already exists: ${input.resource.id}`,
          );
        }
        resources.set(input.resource.id, {
          ...clone(input.resource),
          currentRevisionId: input.revisionId,
          status: input.resource.status ?? "active",
        });
        return;
      }
      case "create_resource_chunk": {
        if (resourceChunks.has(input.chunk.id)) {
          throw new Error(
            `resource chunk already exists: ${input.chunk.id}`,
          );
        }
        if (!resources.has(input.chunk.resourceId)) {
          throw new Error(
            `resource not found: ${input.chunk.resourceId}`,
          );
        }
        resourceChunks.set(input.chunk.id, {
          ...clone(input.chunk),
          status: input.chunk.status ?? "active",
        });
        return;
      }
      case "revise_resource": {
        const resource = resources.get(input.resourceId);
        if (resource === undefined) {
          throw new Error(`resource not found: ${input.resourceId}`);
        }
        resource.contentHash = input.contentHash;
        resource.currentRevisionId = input.revisionId;
        resource.updatedAt = operation.createdAt;
        if (input.metadata !== undefined) {
          resource.metadata = clone(input.metadata);
        }
        return;
      }
      case "tombstone_resource": {
        const resource = resources.get(input.targetId);
        if (resource !== undefined) {
          resource.status = "tombstoned";
          resource.updatedAt = operation.createdAt;
        }
        for (const chunk of resourceChunks.values()) {
          if (chunk.resourceId === input.targetId) {
            chunk.status = "tombstoned";
            chunk.updatedAt = operation.createdAt;
          }
        }
        return;
      }
      case "tombstone_entity": {
        if (input.targetId === operation.rootEntityId) {
          for (const entity of entities.values()) {
            entity.status = "tombstoned";
            entity.updatedAt = operation.createdAt;
          }
          for (const branch of entityBranches.values()) {
            branch.status = "tombstoned";
            branch.updatedAt = operation.createdAt;
          }
          for (const relation of relations.values()) {
            relation.status = "tombstoned";
            relation.updatedAt = operation.createdAt;
          }
          for (const resource of resources.values()) {
            resource.status = "tombstoned";
            resource.updatedAt = operation.createdAt;
          }
          for (const chunk of resourceChunks.values()) {
            chunk.status = "tombstoned";
            chunk.updatedAt = operation.createdAt;
          }
          return;
        }
        const entity = entities.get(input.targetId);
        if (entity !== undefined) {
          entity.status = "tombstoned";
          entity.updatedAt = operation.createdAt;
        }
        for (const relation of relations.values()) {
          if (
            relation.sourceId === input.targetId ||
            relation.targetId === input.targetId
          ) {
            relation.status = "tombstoned";
            relation.updatedAt = operation.createdAt;
          }
        }
        return;
      }
      case "tombstone_entity_branch": {
        const branch = entityBranches.get(input.targetId);
        if (branch !== undefined) {
          branch.status = "tombstoned";
          branch.updatedAt = operation.createdAt;
        }
        return;
      }
      case "tombstone_relation": {
        const relation = relations.get(input.targetId);
        if (relation !== undefined) {
          relation.status = "tombstoned";
          relation.updatedAt = operation.createdAt;
        }
        return;
      }
      case "replace_relation":
      case "revert_commit":
      case "resolve_conflict":
        return;
    }
  }

  private assertRelationEndpointExists(
    kind: MemoryRelation["sourceKind"],
    id: string,
    entities: Map<string, MemoryEntity>,
    entityBranches: Map<string, MemoryEntityBranch>,
    resources: Map<string, Resource>,
    resourceChunks: Map<string, ResourceChunk>,
  ): void {
    const exists =
      kind === "memory_entity"
        ? entities.has(id)
        : kind === "memory_entity_branch"
          ? entityBranches.has(id)
        : kind === "resource"
          ? resources.has(id)
          : resourceChunks.has(id);
    if (!exists) {
      throw new Error(`${kind} not found: ${id}`);
    }
  }
}
