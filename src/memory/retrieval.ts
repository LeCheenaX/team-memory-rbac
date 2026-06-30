import type {
  MemoryEntity,
  MemoryEntityBranch,
  MemoryRelation,
  MemoryRelationType,
  Resource,
  ResourceChunk,
} from "../contracts/memory.ts";
import type {
  PermissionRequest,
  TaskScope,
} from "../contracts/rbac.ts";
import type {
  AuthorizedMemoryRequest,
  MemoryAdapter,
} from "../permission-router.ts";
import type { MemoryActiveView } from "./contracts.ts";
import type {
  MemoryRelationStore,
  VectorMemoryFilter,
  VectorMemoryPoint,
  VectorMemoryStore,
} from "./stores.ts";
import type { Bm25Index } from "../ingestion/bm25.ts";

export type RetrievalOrigin =
  | "cloud_active"
  | "local_snapshot"
  | "local_pending";

export interface EntityRetrievalItem {
  kind: "entity";
  entity: MemoryEntity;
  branch?: MemoryEntityBranch;
  evidence: ResourceChunk[];
  score: number;
  origin: RetrievalOrigin;
}

export interface ResourceChunkRetrievalItem {
  kind: "resource_chunk";
  chunk: ResourceChunk;
  resource?: Resource;
  score: number;
  origin: RetrievalOrigin;
}

export interface RelationRetrievalItem {
  kind: "relation";
  relation: MemoryRelation;
  depth: number;
  score: number;
  origin: RetrievalOrigin;
}

export type MemoryRetrievalItem =
  | EntityRetrievalItem
  | ResourceChunkRetrievalItem
  | RelationRetrievalItem;

export type MemoryRetrievalQuery =
  | {
      kind: "keyword";
      text: string;
      limit?: number;
    }
  | {
      kind: "semantic";
      embedding: number[];
      limit?: number;
    }
  | {
      kind: "entity";
      text?: string;
      entityIds?: string[];
      limit?: number;
    }
  | {
      kind: "relations";
      startEntityId: string;
      relationTypes?: MemoryRelationType[];
      maxDepth: number;
    }
  | {
      kind: "workflow";
      text: string;
      maxDepth: number;
    };

export interface MemoryRetrievalRequest extends PermissionRequest {
  branchRef: string;
  query: MemoryRetrievalQuery;
}

export interface MemoryRetrievalResult {
  rootEntityId: string;
  branchRef: string;
  items: MemoryRetrievalItem[];
}

export interface MemoryQueryContext {
  rootEntityId: string;
  branchRef: string;
  taskScope?: TaskScope;
}

export interface MemoryQuerySource {
  keywordSearch(
    context: MemoryQueryContext,
    text: string,
    limit?: number,
  ): Promise<MemoryRetrievalItem[]>;
  semanticSearch(
    context: MemoryQueryContext,
    embedding: number[],
    limit?: number,
  ): Promise<MemoryRetrievalItem[]>;
  entitySearch(
    context: MemoryQueryContext,
    options: {
      text?: string;
      entityIds?: string[];
      limit?: number;
    },
  ): Promise<EntityRetrievalItem[]>;
  expandRelations(
    context: MemoryQueryContext,
    options: {
      startEntityId: string;
      relationTypes?: MemoryRelationType[];
      maxDepth: number;
    },
  ): Promise<RelationRetrievalItem[]>;
  evidenceFor(
    context: MemoryQueryContext,
    entityIds: string[],
  ): Promise<Map<string, ResourceChunk[]>>;
}

function withinTaskScope(
  item: MemoryRetrievalItem,
  taskScope: TaskScope | undefined,
): boolean {
  if (taskScope === undefined) {
    return true;
  }
  if (item.kind === "entity") {
    if (
      taskScope.allowedEntityIds !== undefined &&
      !taskScope.allowedEntityIds.includes(item.entity.id)
    ) {
      return false;
    }
    if (taskScope.deniedEntityIds?.includes(item.entity.id) === true) {
      return false;
    }
    const tags = item.branch?.tags ?? [];
    if (
      taskScope.allowedTags !== undefined &&
      !tags.some((tag) => taskScope.allowedTags?.includes(tag))
    ) {
      return false;
    }
    if (tags.some((tag) => taskScope.deniedTags?.includes(tag))) {
      return false;
    }
    return true;
  }
  if (item.kind === "resource_chunk") {
    if (
      taskScope.allowedResourceIds !== undefined &&
      !taskScope.allowedResourceIds.includes(item.chunk.resourceId)
    ) {
      return false;
    }
    return (
      taskScope.deniedResourceIds?.includes(item.chunk.resourceId) !== true
    );
  }
  const policy = taskScope.relationExpansionPolicy;
  return (
    (policy?.allowedRelationTypes === undefined ||
      policy.allowedRelationTypes.includes(item.relation.relationType)) &&
    (policy?.maxDepth === undefined || item.depth <= policy.maxDepth)
  );
}

function assertRetrievalRequest(request: MemoryRetrievalRequest): void {
  if (request.rootEntityId.length === 0) {
    throw new Error("retrieval rootEntityId must be non-empty");
  }
  if (request.branchRef.length === 0) {
    throw new Error("retrieval branchRef must be non-empty");
  }
  if (
    request.action !== "read" &&
    request.action !== "search" &&
    request.action !== "traverse_relation"
  ) {
    throw new Error("retrieval adapter only accepts read/search actions");
  }
  const query = request.query;
  if (
    (query.kind === "relations" || query.kind === "workflow") &&
    query.maxDepth < 0
  ) {
    throw new Error("relation maxDepth must be non-negative");
  }
}

export class MemoryRetrievalAdapter
  implements MemoryAdapter<MemoryRetrievalResult, MemoryRetrievalRequest>
{
  private readonly source: MemoryQuerySource;

  constructor(source: MemoryQuerySource) {
    this.source = source;
  }

  async execute(
    request: AuthorizedMemoryRequest<MemoryRetrievalRequest>,
  ): Promise<MemoryRetrievalResult> {
    assertRetrievalRequest(request);
    const context = {
      rootEntityId: request.rootEntityId,
      branchRef: request.branchRef,
      ...(request.taskScope === undefined
        ? {}
        : { taskScope: request.taskScope }),
    };
    let items: MemoryRetrievalItem[];

    switch (request.query.kind) {
      case "keyword":
        items = await this.source.keywordSearch(
          context,
          request.query.text,
          request.query.limit,
        );
        break;
      case "semantic":
        items = await this.source.semanticSearch(
          context,
          request.query.embedding,
          request.query.limit,
        );
        break;
      case "entity":
        items = await this.source.entitySearch(context, request.query);
        break;
      case "relations":
        items = await this.source.expandRelations(context, request.query);
        break;
      case "workflow": {
        const workflowQuery = request.query;
        const entities = await this.source.entitySearch(context, {
          text: workflowQuery.text,
        });
        const expanded = await Promise.all(
          entities.map((item) =>
            this.source.expandRelations(context, {
              startEntityId: item.entity.id,
              relationTypes: ["has", "depends_on", "next_is"],
              maxDepth: workflowQuery.maxDepth,
            }),
          ),
        );
        items = [...entities, ...expanded.flat()];
        break;
      }
    }

    const scoped = items.filter((item) =>
      withinTaskScope(item, request.taskScope),
    );
    const entityItems = scoped.filter(
      (item): item is EntityRetrievalItem => item.kind === "entity",
    );
    const evidence = await this.source.evidenceFor(
      context,
      entityItems.map((item) => item.entity.id),
    );
    const withEvidence = scoped.map((item) =>
      item.kind === "entity"
        ? {
            ...item,
            evidence: (evidence.get(item.entity.id) ?? []).filter(
              (chunk) =>
                withinTaskScope(
                  {
                    kind: "resource_chunk",
                    chunk,
                    score: 1,
                    origin: item.origin,
                  },
                  request.taskScope,
                ),
            ),
          }
        : item,
    );

    return {
      rootEntityId: request.rootEntityId,
      branchRef: request.branchRef,
      items: withEvidence,
    };
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function activeFilter(
  context: MemoryQueryContext,
  extra: Omit<VectorMemoryFilter, "rootEntityId" | "branchRef" | "status"> = {},
): VectorMemoryFilter {
  return {
    rootEntityId: context.rootEntityId,
    branchRef: context.branchRef,
    status: "active",
    ...extra,
  };
}

function entityFilter(
  context: MemoryQueryContext,
  entityIds?: string[],
): VectorMemoryFilter {
  const allowedEntityIds = context.taskScope?.allowedEntityIds;
  const requested =
    entityIds === undefined
      ? allowedEntityIds
      : allowedEntityIds === undefined
        ? entityIds
        : entityIds.filter((id) => allowedEntityIds.includes(id));
  return activeFilter(context, {
    ...(requested === undefined ? {} : { entityId: requested }),
    ...(context.taskScope?.allowedTags === undefined
      ? {}
      : { tagsAny: context.taskScope.allowedTags }),
    ...(context.taskScope?.deniedTags === undefined
      ? {}
      : { tagsNone: context.taskScope.deniedTags }),
  });
}

function resourceFilter(context: MemoryQueryContext): VectorMemoryFilter {
  return activeFilter(context, {
    ...(context.taskScope?.allowedResourceIds === undefined
      ? {}
      : { resourceId: context.taskScope.allowedResourceIds }),
  });
}

function isDeniedEntity(
  context: MemoryQueryContext,
  entityId: string,
): boolean {
  return context.taskScope?.deniedEntityIds?.includes(entityId) === true;
}

function isDeniedResource(
  context: MemoryQueryContext,
  resourceId: string,
): boolean {
  return context.taskScope?.deniedResourceIds?.includes(resourceId) === true;
}

function pointId(point: VectorMemoryPoint): string {
  return (
    (typeof point.payload.memoryId === "string"
      ? point.payload.memoryId
      : undefined) ??
    (typeof point.payload.chunkId === "string"
      ? point.payload.chunkId
      : undefined) ??
    (typeof point.payload.entityBranchId === "string"
      ? point.payload.entityBranchId
      : undefined) ??
    (typeof point.payload.entityId === "string"
      ? point.payload.entityId
      : undefined) ??
    point.id
  );
}

function branchFromPoint(point: VectorMemoryPoint): MemoryEntityBranch {
  return {
    ...(point.payload as unknown as MemoryEntityBranch),
    id:
      (typeof point.payload.entityBranchId === "string"
        ? point.payload.entityBranchId
        : undefined) ?? pointId(point),
  };
}

function entityFromPoint(point: VectorMemoryPoint): MemoryEntity {
  return {
    ...(point.payload as unknown as MemoryEntity),
    id:
      (typeof point.payload.entityId === "string"
        ? point.payload.entityId
        : undefined) ?? pointId(point),
  };
}

function chunkFromPoint(point: VectorMemoryPoint): ResourceChunk {
  return {
    ...(point.payload as unknown as ResourceChunk),
    id:
      (typeof point.payload.chunkId === "string"
        ? point.payload.chunkId
        : undefined) ?? pointId(point),
  };
}

function relationTypesForContext(
  context: MemoryQueryContext,
  requested?: MemoryRelationType[],
): MemoryRelationType[] | undefined {
  const scoped = context.taskScope?.relationExpansionPolicy?.allowedRelationTypes;
  return (
    requested === undefined
      ? scoped
      : scoped === undefined
        ? requested
        : requested.filter((type) => scoped.includes(type))
  );
}

function maxDepthForContext(
  context: MemoryQueryContext,
  requested: number,
): number {
  const scoped = context.taskScope?.relationExpansionPolicy?.maxDepth;
  return scoped === undefined ? requested : Math.min(requested, scoped);
}

export class StoreBackedAuthorizedQuerySource implements MemoryQuerySource {
  private readonly vectors: VectorMemoryStore;
  private readonly relations: MemoryRelationStore;
  private readonly origin: RetrievalOrigin;
  private readonly bm25: Bm25Index | undefined;

  constructor(
    vectors: VectorMemoryStore,
    relations: MemoryRelationStore,
    origin: RetrievalOrigin = "cloud_active",
    bm25?: Bm25Index,
  ) {
    this.vectors = vectors;
    this.relations = relations;
    this.origin = origin;
    this.bm25 = bm25;
  }

  async keywordSearch(
    context: MemoryQueryContext,
    text: string,
    limit = 20,
  ): Promise<MemoryRetrievalItem[]> {
    const [branches, chunkItems] = await Promise.all([
      this.vectors.list({
        collection: "memory_entity_branches",
        filter: entityFilter(context),
        limit,
      }),
      this.keywordChunks(context, text, limit),
    ]);
    const entityItems = await this.entityItemsForBranches(
      context,
      branches.filter((point) => {
        const branch = branchFromPoint(point);
        return (
          includesText(branch.title, text) ||
          includesText(branch.description, text) ||
          branch.tags.some((tag) => includesText(tag, text))
        );
      }),
    );
    return [...entityItems, ...chunkItems].slice(0, limit);
  }

  async semanticSearch(
    context: MemoryQueryContext,
    embedding: number[],
    limit = 20,
  ): Promise<MemoryRetrievalItem[]> {
    const [branchPoints, chunkPoints] = await Promise.all([
      this.vectors.search({
        collection: "memory_entity_branches",
        vector: embedding,
        filter: entityFilter(context),
        limit,
      }),
      this.vectors.search({
        collection: "resource_chunks",
        vector: embedding,
        filter: resourceFilter(context),
        limit,
      }),
    ]);
    const entityItems = await this.entityItemsForBranches(context, branchPoints);
    const chunkItems: ResourceChunkRetrievalItem[] = chunkPoints
      .map((point) => ({ point, chunk: chunkFromPoint(point) }))
      .filter(({ chunk }) => !isDeniedResource(context, chunk.resourceId))
      .map(({ point, chunk }) => ({
        kind: "resource_chunk",
        chunk,
        score: point.score ?? 0,
        origin: this.origin,
      }));
    return [...entityItems, ...chunkItems]
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  async entitySearch(
    context: MemoryQueryContext,
    options: {
      text?: string;
      entityIds?: string[];
      limit?: number;
    },
  ): Promise<EntityRetrievalItem[]> {
    const branches = await this.vectors.list({
      collection: "memory_entity_branches",
      filter: entityFilter(context, options.entityIds),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    return (
      await this.entityItemsForBranches(
        context,
        branches.filter((point) => {
          const branch = branchFromPoint(point);
          return (
            options.text === undefined ||
            includesText(branch.title, options.text) ||
            includesText(branch.description, options.text) ||
            branch.tags.some((tag) => includesText(tag, options.text ?? ""))
          );
        }),
      )
    ).slice(0, options.limit ?? 20);
  }

  async expandRelations(
    context: MemoryQueryContext,
    options: {
      startEntityId: string;
      relationTypes?: MemoryRelationType[];
      maxDepth: number;
    },
  ): Promise<RelationRetrievalItem[]> {
    const maxDepth = maxDepthForContext(context, options.maxDepth);
    const relationTypes = relationTypesForContext(
      context,
      options.relationTypes,
    );
    if (maxDepth === 0 || relationTypes?.length === 0) {
      return [];
    }

    const results: RelationRetrievalItem[] = [];
    let frontier = [options.startEntityId].filter(
      (id) => !isDeniedEntity(context, id),
    );
    const visited = new Set(frontier);
    for (let depth = 1; depth <= maxDepth; depth += 1) {
      const next: string[] = [];
      for (const sourceId of frontier) {
        const relations = await this.relations.list({
          rootEntityId: context.rootEntityId,
          branchRef: context.branchRef,
          sourceId,
          ...(relationTypes === undefined ? {} : { relationTypes }),
          status: "active",
        });
        for (const relation of relations) {
          results.push({
            kind: "relation",
            relation,
            depth,
            score: relation.weight,
            origin: this.origin,
          });
          if (
            relation.targetKind === "memory_entity" &&
            !visited.has(relation.targetId) &&
            !isDeniedEntity(context, relation.targetId)
          ) {
            visited.add(relation.targetId);
            next.push(relation.targetId);
          }
        }
      }
      frontier = next;
      if (frontier.length === 0) {
        break;
      }
    }
    return results;
  }

  async evidenceFor(
    context: MemoryQueryContext,
    entityIds: string[],
  ): Promise<Map<string, ResourceChunk[]>> {
    const result = new Map<string, ResourceChunk[]>();
    const scopedEntityIds = entityIds.filter((id) => !isDeniedEntity(context, id));
    for (const entityId of scopedEntityIds) {
      const evidenceRelations = await this.relations.list({
        rootEntityId: context.rootEntityId,
        branchRef: context.branchRef,
        sourceId: entityId,
        relationTypes: ["refers_to"],
        status: "active",
      });
      const chunks = await this.vectors.list({
        collection: "resource_chunks",
        filter: resourceFilter(context),
        limit: 100,
      });
      const byId = new Map(
        chunks
          .map(chunkFromPoint)
          .filter((chunk) => !isDeniedResource(context, chunk.resourceId))
          .map((chunk) => [chunk.id, chunk]),
      );
      const evidence = evidenceRelations
        .filter((relation) => relation.targetKind === "resource_chunk")
        .map((relation) => byId.get(relation.targetId))
        .filter((chunk): chunk is ResourceChunk => chunk !== undefined);
      if (evidence.length > 0) {
        result.set(entityId, evidence);
      }
    }
    return result;
  }

  private async entityItemsForBranches(
    context: MemoryQueryContext,
    points: VectorMemoryPoint[],
  ): Promise<EntityRetrievalItem[]> {
    const items: EntityRetrievalItem[] = [];
    for (const point of points) {
      const branch = branchFromPoint(point);
      if (isDeniedEntity(context, branch.entityId)) {
        continue;
      }
      const entityPoint = await this.vectors.get(
        "memory_entities",
        branch.entityId,
      );
      if (entityPoint === undefined) {
        continue;
      }
      const entity = entityFromPoint(entityPoint);
      if (entity.status !== "active" || isDeniedEntity(context, entity.id)) {
        continue;
      }
      items.push({
        kind: "entity",
        entity,
        branch,
        evidence: [],
        score: point.score ?? 1,
        origin: this.origin,
      });
    }
    return items;
  }

  private async keywordChunks(
    context: MemoryQueryContext,
    text: string,
    limit: number,
  ): Promise<ResourceChunkRetrievalItem[]> {
    if (this.bm25 !== undefined) {
      const results = await this.bm25.search({
        rootEntityId: context.rootEntityId,
        branchRef: context.branchRef,
        text,
        limit,
        ...(context.taskScope?.allowedResourceIds === undefined
          ? {}
          : { allowedResourceIds: context.taskScope.allowedResourceIds }),
        ...(context.taskScope?.deniedResourceIds === undefined
          ? {}
          : { deniedResourceIds: context.taskScope.deniedResourceIds }),
      });
      const chunks = await this.vectors.list({
        collection: "resource_chunks",
        filter: resourceFilter(context),
        limit: Math.max(results.length, limit),
      });
      const byId = new Map(
        chunks
          .map(chunkFromPoint)
          .filter((chunk) => !isDeniedResource(context, chunk.resourceId))
          .map((chunk) => [chunk.id, chunk]),
      );
      const matched: Array<{
        result: (typeof results)[number];
        chunk: ResourceChunk;
      }> = [];
      for (const result of results) {
        const chunk = byId.get(result.document.chunkId);
        if (chunk !== undefined) {
          matched.push({ result, chunk });
        }
      }
      return matched.map(({ result, chunk }) => ({
          kind: "resource_chunk",
          chunk,
          score: result.score,
          origin: this.origin,
        }));
    }
    const chunks = await this.vectors.list({
      collection: "resource_chunks",
      filter: resourceFilter(context),
      limit,
    });
    return chunks
      .map(chunkFromPoint)
      .filter(
        (chunk) =>
          !isDeniedResource(context, chunk.resourceId) &&
          includesText(chunk.text, text),
      )
      .map((chunk) => ({
        kind: "resource_chunk",
        chunk,
        score: 1,
        origin: this.origin,
      }));
  }
}

function dotProduct(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let score = 0;
  for (let index = 0; index < length; index += 1) {
    score += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return score;
}

function includesText(value: string, query: string): boolean {
  return value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

export class InMemoryAuthorizedQuerySource implements MemoryQuerySource {
  private readonly readView: (
    rootEntityId: string,
    branchRef: string,
  ) => MemoryActiveView | Promise<MemoryActiveView>;
  private readonly origin: RetrievalOrigin;
  private readonly originFor:
    | ((
        kind: "entity" | "relation" | "resource_chunk",
        id: string,
      ) => RetrievalOrigin)
    | undefined;

  constructor(
    readView: (
      rootEntityId: string,
      branchRef: string,
    ) => MemoryActiveView | Promise<MemoryActiveView>,
    origin: RetrievalOrigin = "cloud_active",
    originFor?: (
      kind: "entity" | "relation" | "resource_chunk",
      id: string,
    ) => RetrievalOrigin,
  ) {
    this.readView = readView;
    this.origin = origin;
    this.originFor = originFor;
  }

  async keywordSearch(
    context: MemoryQueryContext,
    text: string,
    limit = 20,
  ): Promise<MemoryRetrievalItem[]> {
    const view = await this.readView(
      context.rootEntityId,
      context.branchRef,
    );
    const entityItems = this.entityItems(view).filter(
      (item) =>
        includesText(item.branch?.title ?? "", text) ||
        includesText(item.branch?.description ?? "", text) ||
        item.branch?.tags.some((tag) => includesText(tag, text)) === true,
    );
    const chunkItems: ResourceChunkRetrievalItem[] = view.resourceChunks
      .filter((chunk) => includesText(chunk.text, text))
      .map((chunk) => {
        const resource = view.resources.find(
          (candidate) => candidate.id === chunk.resourceId,
        );
        return {
          kind: "resource_chunk",
          chunk,
          ...(resource === undefined ? {} : { resource }),
          score: 1,
          origin:
            this.originFor?.("resource_chunk", chunk.id) ??
            this.origin,
        };
      });
    return [...entityItems, ...chunkItems].slice(0, limit);
  }

  async semanticSearch(
    context: MemoryQueryContext,
    embedding: number[],
    limit = 20,
  ): Promise<MemoryRetrievalItem[]> {
    const view = await this.readView(
      context.rootEntityId,
      context.branchRef,
    );
    const entities = this.entityItems(view)
      .filter(
        (item) =>
          (item.branch as { embedding?: number[] } | undefined)?.embedding !==
          undefined,
      )
      .map((item) => ({
        ...item,
        score: dotProduct(
          (item.branch as { embedding?: number[] } | undefined)?.embedding ?? [],
          embedding,
        ),
      }));
    const chunks: ResourceChunkRetrievalItem[] = view.resourceChunks
      .filter(
        (chunk) =>
          (chunk as { embedding?: number[] }).embedding !== undefined,
      )
      .map((chunk) => {
        const resource = view.resources.find(
          (candidate) => candidate.id === chunk.resourceId,
        );
        return {
          kind: "resource_chunk",
          chunk,
          ...(resource === undefined ? {} : { resource }),
          score: dotProduct(
            (chunk as { embedding?: number[] }).embedding ?? [],
            embedding,
          ),
          origin:
            this.originFor?.("resource_chunk", chunk.id) ??
            this.origin,
        };
      });
    return [...entities, ...chunks]
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  async entitySearch(
    context: MemoryQueryContext,
    options: {
      text?: string;
      entityIds?: string[];
      limit?: number;
    },
  ): Promise<EntityRetrievalItem[]> {
    const view = await this.readView(
      context.rootEntityId,
      context.branchRef,
    );
    return this.entityItems(view)
      .filter(
        (item) =>
          (options.entityIds === undefined ||
            options.entityIds.includes(item.entity.id)) &&
          (options.text === undefined ||
            includesText(item.branch?.title ?? "", options.text) ||
            includesText(item.branch?.description ?? "", options.text) ||
            item.branch?.tags.some((tag) =>
              includesText(tag, options.text ?? ""),
            ) === true),
      )
      .slice(0, options.limit ?? 20);
  }

  async expandRelations(
    context: MemoryQueryContext,
    options: {
      startEntityId: string;
      relationTypes?: MemoryRelationType[];
      maxDepth: number;
    },
  ): Promise<RelationRetrievalItem[]> {
    const view = await this.readView(
      context.rootEntityId,
      context.branchRef,
    );
    const results: RelationRetrievalItem[] = [];
    let frontier = [options.startEntityId];
    const visited = new Set(frontier);

    for (let depth = 1; depth <= options.maxDepth; depth += 1) {
      const next: string[] = [];
      for (const relation of view.relations) {
        if (
          !frontier.includes(relation.sourceId) ||
          (options.relationTypes !== undefined &&
            !options.relationTypes.includes(relation.relationType))
        ) {
          continue;
        }
        results.push({
          kind: "relation",
          relation,
          depth,
          score: relation.weight,
          origin:
            this.originFor?.("relation", relation.id) ??
            this.origin,
        });
        if (
          relation.targetKind === "memory_entity" &&
          !visited.has(relation.targetId)
        ) {
          visited.add(relation.targetId);
          next.push(relation.targetId);
        }
      }
      frontier = next;
      if (frontier.length === 0) {
        break;
      }
    }
    return results;
  }

  async evidenceFor(
    context: MemoryQueryContext,
    entityIds: string[],
  ): Promise<Map<string, ResourceChunk[]>> {
    const view = await this.readView(
      context.rootEntityId,
      context.branchRef,
    );
    const result = new Map<string, ResourceChunk[]>();
    for (const relation of view.relations) {
      if (
        relation.relationType !== "refers_to" ||
        relation.sourceKind !== "memory_entity" ||
        relation.targetKind !== "resource_chunk" ||
        !entityIds.includes(relation.sourceId)
      ) {
        continue;
      }
      const chunk = view.resourceChunks.find(
        (candidate) => candidate.id === relation.targetId,
      );
      if (chunk !== undefined) {
        result.set(relation.sourceId, [
          ...(result.get(relation.sourceId) ?? []),
          chunk,
        ]);
      }
    }
    return result;
  }

  private entityItems(view: MemoryActiveView): EntityRetrievalItem[] {
    return view.entities.map((entity) => {
      const branch = view.entityBranches.find(
        (branch) => branch.id === entity.currentBranchId,
      );
      return {
        kind: "entity",
        entity,
        ...(branch === undefined ? {} : { branch }),
        evidence: [],
        score: 1,
        origin:
          this.originFor?.("entity", entity.id) ??
          this.origin,
      };
    });
  }
}
