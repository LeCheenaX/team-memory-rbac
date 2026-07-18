import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  MemoryEntity,
  MemoryEntityBranch,
  MemoryRelation,
  MemoryRelationType,
  RelationEndpointKind,
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
import {
  bm25Internals,
} from "../ingestion/bm25.ts";
import type { EmbeddingProvider } from "../ingestion/service.ts";

export type RetrievalOrigin =
  | "cloud_active"
  | "local_snapshot"
  | "local_pending";

export interface EntityRetrievalItem {
  kind: "entity";
  entity: MemoryEntity;
  branch?: MemoryEntityBranch;
  packedRelations?: MemoryRelation[];
  packedEntities?: MemoryEntity[];
  packedBranches?: MemoryEntityBranch[];
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
      kind: "recall";
      text: string;
      limit?: number;
      layer?: "L1" | "L2" | "L3";
      names?: string[];
      tagsAny?: string[];
    }
  | {
      kind: "keyword";
      text: string;
      limit?: number;
      tagsAny?: string[];
      tagsNone?: string[];
    }
  | {
      kind: "semantic";
      embedding: number[];
      limit?: number;
      tagsAny?: string[];
      tagsNone?: string[];
    }
  | {
      kind: "entity";
      text?: string;
      entityIds?: string[];
      limit?: number;
      tagsAny?: string[];
      tagsNone?: string[];
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
      tagsAny?: string[];
      tagsNone?: string[];
    };

export interface MemoryRetrievalRequest extends PermissionRequest {
  branchRef: string;
  query: MemoryRetrievalQuery;
}

export interface RecallDiagnostics {
  extractedAtoms: string[];
  laneCandidates: {
    exactName: number;
    nameKeyword: number;
    nameSemantic: number;
    queryKeyword: number;
    atomKeyword: number;
    semantic: number;
  };
  semanticCandidateFloor: number;
  thresholdPruned: number;
  relationExpansions: number;
  finalCandidates: number;
}

export interface MemoryRetrievalResult {
  rootEntityId: string;
  branchRef: string;
  items: MemoryRetrievalItem[];
  diagnostics?: RecallDiagnostics;
  warnings?: Array<
    | {
        code: "unknown_catalog_tags";
        field: "tagsAny";
        unknownTags: string[];
      }
    | {
        code: "unresolved_names";
        field: "names";
        unresolvedNames: string[];
      }
  >;
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
  relationsForObject(
    context: MemoryQueryContext,
    options: {
      objectId: string;
      relationTypes?: MemoryRelationType[];
    },
  ): Promise<MemoryRelation[]>;
  resolveObjects(
    context: MemoryQueryContext,
    objects: Array<{
      id: string;
      kind: RelationEndpointKind;
    }>,
  ): Promise<MemoryRetrievalItem[]>;
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

function withinQueryTags(
  item: MemoryRetrievalItem,
  query: MemoryRetrievalQuery,
): boolean {
  if (!("tagsAny" in query) && !("tagsNone" in query)) {
    return true;
  }
  if (item.kind === "relation") {
    return true;
  }
  if (item.kind !== "entity") {
    return query.kind === "recall" && query.layer === "L1";
  }
  const tags = item.entity.tags ?? item.branch?.tags ?? [];
  const tagsAny = "tagsAny" in query ? query.tagsAny : undefined;
  const tagsNone = "tagsNone" in query ? query.tagsNone : undefined;
  return (
    (tagsAny === undefined || tagsAny.some((tag) => tags.includes(tag))) &&
    (tagsNone === undefined || !tagsNone.some((tag) => tags.includes(tag)))
  );
}

function withinQueryNames(
  item: MemoryRetrievalItem,
  query: MemoryRetrievalQuery,
): boolean {
  if (query.kind !== "recall" || query.names === undefined) {
    return true;
  }
  if (item.kind !== "entity") {
    return false;
  }
  const candidates = [
    item.entity.name,
    item.entity.title,
    item.entity.description,
    item.branch?.title,
    item.branch?.description,
    item.entity.id,
  ].filter((value): value is string => typeof value === "string");
  return query.names.some((name) =>
    candidates.some((candidate) =>
      candidate.toLocaleLowerCase() === name.toLocaleLowerCase()
    )
  );
}

function withinResolvedNameScope(
  item: MemoryRetrievalItem,
  query: MemoryRetrievalQuery,
  objectIds: ReadonlySet<string>,
): boolean {
  if (query.kind !== "recall" || query.names === undefined) {
    return true;
  }
  if (item.kind === "relation") {
    return (
      objectIds.has(item.relation.id) ||
      (objectIds.has(item.relation.sourceId) &&
        objectIds.has(item.relation.targetId))
    );
  }
  if (item.kind === "resource_chunk") {
    return objectIds.has(item.chunk.id) || objectIds.has(item.chunk.resourceId);
  }
  const primaryInScope =
    objectIds.has(item.entity.id) ||
    (item.branch !== undefined && objectIds.has(item.branch.id));
  const packedInScope =
    (item.packedEntities ?? []).every((entity) => objectIds.has(entity.id)) &&
    (item.packedBranches ?? []).every((branch) => objectIds.has(branch.id)) &&
    (item.packedRelations ?? []).every((relation) =>
      objectIds.has(relation.sourceId) && objectIds.has(relation.targetId)
    );
  return primaryInScope && packedInScope;
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
  if (query.kind === "recall") {
    if (query.text.trim().length === 0) {
      throw new Error("recall query text must be non-empty");
    }
    if (
      query.layer !== undefined &&
      query.layer !== "L1" &&
      query.layer !== "L2" &&
      query.layer !== "L3"
    ) {
      throw new Error("recall layer must be L1, L2, or L3");
    }
  }
}

export interface EntityExtractor {
  extract(text: string): string[];
}

export type SpacyExtractionRunner = (
  text: string,
  maxAtoms: number,
) => string[];

function runPythonSpacyExtraction(text: string, maxAtoms: number): string[] {
  const python = process.env.TEAM_MEMORY_SPACY_PYTHON ?? "python3";
  const script = fileURLToPath(
    new URL("../../scripts/spacy-extract.py", import.meta.url),
  );
  let output: string;
  try {
    output = execFileSync(
      python,
      [script, text, String(maxAtoms)],
      {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      },
    );
  } catch (error) {
    throw new Error(
      `spaCy query extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new Error("spaCy query extraction returned an invalid response");
  }
  return parsed;
}

export class SpacyEntityExtractor implements EntityExtractor {
  private readonly runner: SpacyExtractionRunner;
  private readonly maxAtoms: number;

  constructor(
    runner: SpacyExtractionRunner = runPythonSpacyExtraction,
    maxAtoms = 8,
  ) {
    this.runner = runner;
    this.maxAtoms = maxAtoms;
  }

  extract(text: string): string[] {
    return [...new Set(
      this.runner(text, this.maxAtoms).map((value) => value.trim()).filter(Boolean),
    )].slice(0, this.maxAtoms);
  }
}
export class HeuristicEntityExtractor implements EntityExtractor {
  extract(text: string): string[] {
    const tokens = bm25Internals.tokenize(text);
    const phrases = text
      .match(/(?:\b[A-Z][\p{L}\p{N}_-]*\b(?:\s+\b[A-Z][\p{L}\p{N}_-]*\b){0,3})/gu) ??
      [];
    return [
      ...new Set([
        ...phrases.map((phrase) => phrase.trim()).filter(Boolean),
        ...tokens.filter((token) => token.length >= 4),
      ]),
    ].slice(0, 8);
  }
}

interface RecallSignals {
  item: MemoryRetrievalItem;
  semantic: number;
  bm25: number;
  entityBoost: number;
}

const DEFAULT_RECALL_TOP_P = 0.8;
const DEFAULT_SEMANTIC_CANDIDATE_FLOOR = 0.1;

function assertRecallTopP(value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error("recallTopP must be greater than 0 and less than or equal to 1");
  }
}

function assertSemanticCandidateFloor(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("semanticCandidateFloor must be between 0 and 1");
  }
}

function fragmentKey(item: MemoryRetrievalItem): string {
  if (item.kind === "entity") {
    return `entity:${item.entity.id}:${item.branch?.id ?? ""}`;
  }
  if (item.kind === "resource_chunk") {
    return `chunk:${item.chunk.id}`;
  }
  return `relation:${item.relation.id}`;
}

function itemKey(item: MemoryRetrievalItem): string {
  if (
    item.kind !== "entity" ||
    ((item.packedRelations?.length ?? 0) === 0 &&
      (item.packedEntities?.length ?? 0) === 0 &&
      (item.packedBranches?.length ?? 0) === 0)
  ) {
    return fragmentKey(item);
  }
  const objects = [
    item.branch === undefined
      ? `memory_entity:${item.entity.id}`
      : `memory_entity_branch:${item.branch.id}`,
    ...(item.packedEntities ?? []).map((entity) =>
      `memory_entity:${entity.id}`
    ),
    ...(item.packedBranches ?? []).map((branch) =>
      `memory_entity_branch:${branch.id}`
    ),
    ...item.evidence.map((chunk) => `resource_chunk:${chunk.id}`),
  ].sort();
  const relations = (item.packedRelations ?? [])
    .map((relation) => relation.id)
    .sort();
  return `composite:${objects.join("|")}:${relations.join("|")}`;
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function mergeRetrievalItems(
  current: MemoryRetrievalItem,
  incoming: MemoryRetrievalItem,
): MemoryRetrievalItem {
  if (current.kind !== "entity" || incoming.kind !== "entity") {
    return current;
  }
  const primaryBranchId = current.branch?.id;
  return {
    ...current,
    packedRelations: uniqueById([
      ...(current.packedRelations ?? []),
      ...(incoming.packedRelations ?? []),
    ]),
    packedEntities: uniqueById([
      ...(current.packedEntities ?? []),
      ...(incoming.packedEntities ?? []),
    ]).filter((entity) => entity.id !== current.entity.id),
    packedBranches: uniqueById([
      ...(current.packedBranches ?? []),
      ...(incoming.packedBranches ?? []),
    ]).filter((branch) => branch.id !== primaryBranchId),
    evidence: uniqueById([...current.evidence, ...incoming.evidence]),
  };
}

function compositeContainsFragment(
  composite: EntityRetrievalItem,
  candidate: MemoryRetrievalItem,
): boolean {
  const relations = composite.packedRelations ?? [];
  if (relations.length === 0) return false;
  if (candidate.kind === "relation") {
    return relations.some((relation) => relation.id === candidate.relation.id);
  }
  const endpoints = relations.flatMap((relation) => [
    { id: relation.sourceId, kind: relation.sourceKind },
    { id: relation.targetId, kind: relation.targetKind },
  ]);
  if (candidate.kind === "resource_chunk") {
    return endpoints.some((endpoint) =>
      (endpoint.kind === "resource_chunk" && endpoint.id === candidate.chunk.id) ||
      (endpoint.kind === "resource" && endpoint.id === candidate.chunk.resourceId)
    );
  }
  return endpoints.some((endpoint) =>
    (endpoint.kind === "memory_entity" &&
      endpoint.id === candidate.entity.id) ||
    (endpoint.kind === "memory_entity_branch" &&
      endpoint.id === candidate.branch?.id)
  );
}

function cloneItem<T extends MemoryRetrievalItem>(item: T): T {
  return structuredClone(item);
}

function relationExpansionObjectIds(item: MemoryRetrievalItem): string[] {
  if (item.kind === "entity") {
    return [
      item.entity.id,
      ...(item.branch === undefined ? [] : [item.branch.id]),
    ];
  }
  if (item.kind === "resource_chunk") {
    return [
      item.chunk.id,
      item.chunk.resourceId,
      ...(item.resource === undefined ? [] : [item.resource.id]),
    ];
  }
  return [
    item.relation.id,
    item.relation.sourceId,
    item.relation.targetId,
  ];
}

function bm25Parameters(queryTerms: number): {
  midpoint: number;
  steepness: number;
} {
  if (queryTerms <= 3) return { midpoint: 5.0, steepness: 0.7 };
  if (queryTerms <= 6) return { midpoint: 7.0, steepness: 0.6 };
  if (queryTerms <= 9) return { midpoint: 9.0, steepness: 0.5 };
  if (queryTerms <= 15) return { midpoint: 10.0, steepness: 0.5 };
  return { midpoint: 12.0, steepness: 0.5 };
}

export function normalizeBm25Score(
  rawScore: number,
  queryText: string,
): number {
  const terms = bm25Internals.tokenize(queryText).length;
  const { midpoint, steepness } = bm25Parameters(terms);
  return 1 / (1 + Math.exp(-steepness * (rawScore - midpoint)));
}

export interface SemanticCandidateCalibrationSample {
  fact: string;
  relatedKeyword: string;
  unrelatedKeyword: string;
}

export interface SemanticCandidateCalibration {
  model: string;
  relatedSimilarities: number[];
  unrelatedSimilarities: number[];
  recommendedFloor: number;
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue ** 2;
    rightMagnitude += rightValue ** 2;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

export async function calibrateSemanticCandidateFloor(
  embeddings: EmbeddingProvider,
  model: string,
  samples: SemanticCandidateCalibrationSample[],
): Promise<SemanticCandidateCalibration> {
  if (samples.length === 0) {
    throw new Error("semantic candidate calibration requires samples");
  }
  const relatedSimilarities: number[] = [];
  const unrelatedSimilarities: number[] = [];
  for (const sample of samples) {
    const [fact, related, unrelated] = await Promise.all([
      embeddings.embed(sample.fact),
      embeddings.embed(sample.relatedKeyword),
      embeddings.embed(sample.unrelatedKeyword),
    ]);
    relatedSimilarities.push(cosineSimilarity(fact, related));
    unrelatedSimilarities.push(cosineSimilarity(fact, unrelated));
  }
  const lowestRelated = Math.min(...relatedSimilarities);
  const recommendedFloor = Math.max(
    0,
    Math.min(1, Math.floor(lowestRelated * 10) / 10),
  );
  return {
    model,
    relatedSimilarities,
    unrelatedSimilarities,
    recommendedFloor,
  };
}

function keywordDocumentText(item: MemoryRetrievalItem): string {
  if (item.kind === "resource_chunk") return item.chunk.text;
  if (item.kind === "relation") return "";
  return [
    item.entity.name,
    item.entity.title,
    item.entity.description,
    ...(item.entity.tags ?? []),
    item.branch?.title,
    item.branch?.description,
    ...(item.branch?.tags ?? []),
  ].filter((value): value is string => typeof value === "string").join(" ");
}

function scoreKeywordItems(
  items: MemoryRetrievalItem[],
  text: string,
  limit: number,
): MemoryRetrievalItem[] {
  const byId = new Map(items.map((item) => [fragmentKey(item), item]));
  const documents = items.map((item) => {
    const id = fragmentKey(item);
    return {
      id,
      rootEntityId: "",
      branchRef: "",
      resourceId: id,
      revisionId: id,
      chunkId: id,
      text: keywordDocumentText(item),
      status: "active" as const,
    };
  });
  return bm25Internals.scoreDocuments(documents, text, limit).map((result) => ({
    ...cloneItem(byId.get(result.document.id) as MemoryRetrievalItem),
    score: result.score,
  }));
}

function relationBoostWeight(relation: MemoryRelation): number {
  switch (relation.relationType) {
    case "depends_on":
    case "next_is":
      return 1.5;
    case "contradicts":
      return 1.0;
    case "supersedes":
      return 1.0;
    case "refers_to":
      return 0.8;
    case "has":
    case "relates_to":
      return 0.5;
  }
}

function memoryCountWeight(count: number): number {
  return 1.0 / (1.0 + 0.001 * (count - 1) ** 2);
}

function maxExpected(signals: RecallSignals): number {
  const hasSemantic = signals.semantic > 0;
  const hasBm25 = signals.bm25 > 0;
  const hasEntity = signals.entityBoost > 0;
  if (hasSemantic && hasBm25 && hasEntity) return 3.0;
  if (hasSemantic && hasBm25) return 2.0;
  if (hasSemantic && hasEntity) return 2.0;
  if (hasSemantic) return 1.0;
  if (hasBm25 && hasEntity) return 2.0;
  return 1.0;
}

function fuseScore(signals: RecallSignals): number {
  const raw = signals.semantic + signals.bm25 + signals.entityBoost;
  return Math.min(raw / maxExpected(signals), 1.0);
}

function selectTopP<T extends MemoryRetrievalItem>(
  candidates: T[],
  limit: number,
  topP: number,
): T[] {
  if (limit <= 0) return [];
  const totalScore = candidates.reduce((total, item) => total + item.score, 0);
  if (totalScore <= 0) return [];
  const threshold = totalScore * topP;
  const selected: T[] = [];
  let cumulativeScore = 0;
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    selected.push(candidate);
    cumulativeScore += candidate.score;
    if (cumulativeScore >= threshold) break;
  }
  return selected;
}

function relationCanPackFromHit(
  relation: MemoryRelation,
  hitObjectId: string,
): boolean {
  switch (relation.relationType) {
    case "has":
    case "relates_to":
      return false;
    case "depends_on":
    case "refers_to":
      return relation.sourceId === hitObjectId;
    case "contradicts":
      return true;
    case "supersedes":
      return relation.targetId === hitObjectId;
    case "next_is":
      return true;
  }
}

export class MemoryRetrievalAdapter
  implements MemoryAdapter<MemoryRetrievalResult, MemoryRetrievalRequest>
{
  private readonly source: MemoryQuerySource;
  private readonly embeddings: EmbeddingProvider;
  private readonly entityExtractor: EntityExtractor;
  private readonly recallTopP: number;
  private readonly semanticCandidateFloor: number;

  constructor(
    source: MemoryQuerySource,
    options: {
      embeddings: EmbeddingProvider;
      entityExtractor?: EntityExtractor;
      recallTopP?: number;
      semanticCandidateFloor?: number;
    },
  ) {
    this.source = source;
    this.embeddings = options.embeddings;
    this.entityExtractor = options.entityExtractor ?? new HeuristicEntityExtractor();
    this.recallTopP = options.recallTopP ?? DEFAULT_RECALL_TOP_P;
    assertRecallTopP(this.recallTopP);
    this.semanticCandidateFloor =
      options.semanticCandidateFloor ??
      DEFAULT_SEMANTIC_CANDIDATE_FLOOR;
    assertSemanticCandidateFloor(this.semanticCandidateFloor);
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
    let diagnostics: RecallDiagnostics | undefined;
    let unresolvedNames: string[] = [];

    switch (request.query.kind) {
      case "recall": {
        const recall = await this.recall(context, request.query);
        items = recall.items;
        diagnostics = recall.diagnostics;
        unresolvedNames = recall.unresolvedNames;
        break;
      }
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
      withinTaskScope(item, request.taskScope) &&
      withinQueryTags(item, request.query),
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
            evidence: uniqueById([
              ...item.evidence,
              ...(evidence.get(item.entity.id) ?? []),
            ]).filter(
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
    const outputItems =
      request.query.kind === "recall" &&
      (request.query.layer ?? "L3") === "L3"
        ? withEvidence.map((item) =>
            item.kind === "entity"
              ? {
                  kind: "entity" as const,
                  entity: item.entity,
                  evidence: item.evidence,
                  score: item.score,
                  origin: item.origin,
                }
              : item,
          )
        : withEvidence;

    return {
      rootEntityId: request.rootEntityId,
      branchRef: request.branchRef,
      items: outputItems,
      ...(diagnostics === undefined ? {} : { diagnostics }),
      ...(unresolvedNames.length === 0
        ? {}
        : {
            warnings: [{
              code: "unresolved_names" as const,
              field: "names" as const,
              unresolvedNames,
            }],
          }),
    };
  }

  private async recall(
    context: MemoryQueryContext,
    query: Extract<MemoryRetrievalQuery, { kind: "recall" }>,
  ): Promise<{
    items: MemoryRetrievalItem[];
    diagnostics: RecallDiagnostics;
    unresolvedNames: string[];
  }> {
    const layer = query.layer ?? "L3";
    const limit = query.limit ?? 10;
    const candidateLimit = Math.max(limit * 4, 20);
    const laneCandidates = {
      exactName: 0,
      nameKeyword: 0,
      nameSemantic: 0,
      queryKeyword: 0,
      atomKeyword: 0,
      semantic: 0,
    };
    const unresolvedNames: string[] = [];
    const expandedRelationIds = new Set<string>();
    const scopedContext =
      query.tagsAny === undefined
        ? context
        : {
            ...context,
            taskScope: {
              ...(context.taskScope ?? { rootEntityId: context.rootEntityId }),
              allowedTags:
                context.taskScope?.allowedTags === undefined
                  ? query.tagsAny
                  : context.taskScope.allowedTags.filter((tag) =>
                      query.tagsAny?.includes(tag)
                    ),
            },
          };
    const signals = new Map<string, RecallSignals>();
    const addSignal = (
      item: MemoryRetrievalItem,
      signal: Partial<Omit<RecallSignals, "item">>,
    ) => {
      const key = itemKey(item);
      const current = signals.get(key) ?? {
        item: cloneItem(item),
        semantic: 0,
        bm25: 0,
        entityBoost: 0,
      };
      current.item = mergeRetrievalItems(current.item, item);
      current.semantic = Math.max(current.semantic, signal.semantic ?? 0);
      current.bm25 = Math.max(current.bm25, signal.bm25 ?? 0);
      current.entityBoost += signal.entityBoost ?? 0;
      signals.set(key, current);
    };

    const resolvedNameScope = new Set<string>();
    for (const name of query.names ?? []) {
      const normalizedName = name.toLocaleLowerCase();
      const visibleMatches = await this.source.entitySearch(scopedContext, {
        text: name,
        limit: candidateLimit,
      });
      const exactMatches = visibleMatches.filter((item) =>
        [item.entity.name, item.entity.title]
          .filter((value): value is string => typeof value === "string")
          .some((value) => value.toLocaleLowerCase() === normalizedName)
      );
      laneCandidates.exactName += new Set(
        exactMatches.map((item) => item.entity.id),
      ).size;
      if (exactMatches.length === 0) unresolvedNames.push(name);
      for (const item of exactMatches) {
        resolvedNameScope.add(item.entity.id);
        addSignal(
          cloneItem(item),
          { entityBoost: 1 },
        );
      }
      const keywordMatches = await this.source.keywordSearch(
        scopedContext,
        name,
        candidateLimit,
      );
      laneCandidates.nameKeyword += keywordMatches.length;
      for (const item of keywordMatches) {
        addSignal(item, {
          bm25: normalizeBm25Score(item.score, name),
        });
      }
      const nameEmbedding = await this.embeddings.embed(name);
      const semanticMatches = await this.source.semanticSearch(
        scopedContext,
        nameEmbedding,
        candidateLimit,
      );
      laneCandidates.nameSemantic += semanticMatches.length;
      for (const item of semanticMatches) {
        addSignal(item, { semantic: item.score });
      }
    }

    const bm25Items = await this.source.keywordSearch(
      scopedContext,
      query.text,
      candidateLimit,
    );
    laneCandidates.queryKeyword += bm25Items.length;
    for (const item of bm25Items) {
      addSignal(item, {
        bm25: normalizeBm25Score(item.score, query.text),
      });
    }

    const extractedAtoms = this.entityExtractor.extract(query.text).slice(0, 8);
    const querySignals = [...new Set([...extractedAtoms, query.text])];
    for (const signalText of querySignals) {
      if (signalText !== query.text) {
        const atomKeywordItems = await this.source.keywordSearch(
          scopedContext,
          signalText,
          candidateLimit,
        );
        laneCandidates.atomKeyword += atomKeywordItems.length;
        for (const item of atomKeywordItems) {
          addSignal(item, {
            bm25: normalizeBm25Score(item.score, signalText),
          });
        }
      }
      const embedding = await this.embeddings.embed(signalText);
      const semanticItems = await this.source.semanticSearch(
        scopedContext,
        embedding,
        candidateLimit,
      );
      laneCandidates.semantic += semanticItems.length;
      for (const item of semanticItems) {
        addSignal(item, { semantic: item.score });
      }
    }

    if (layer === "L2") {
      const relationExpansionHits = [...signals.values()].map((entry) => ({
        item: entry.item,
        semantic: entry.semantic,
        bm25: entry.bm25,
        score: fuseScore(entry),
      }));
      for (const hit of relationExpansionHits) {
        const objectIds = [...new Set(relationExpansionObjectIds(hit.item))];
        const seenRelationIds = new Set<string>();
        for (const objectId of objectIds) {
          const relations = await this.source.relationsForObject(scopedContext, {
            objectId,
          });
          const byType = new Map<MemoryRelationType, MemoryRelation[]>();
          for (const relation of relations) {
            byType.set(relation.relationType, [
              ...(byType.get(relation.relationType) ?? []),
              relation,
            ]);
          }
          for (const relation of relations) {
            if (seenRelationIds.has(relation.id)) continue;
            seenRelationIds.add(relation.id);
            expandedRelationIds.add(relation.id);
            const entityBoost =
              hit.score *
              relationBoostWeight(relation) *
              memoryCountWeight(byType.get(relation.relationType)?.length ?? 1);
            const relationItem: RelationRetrievalItem = {
              kind: "relation",
              relation,
              depth: 1,
              score: relation.weight,
              origin: hit.item.origin,
            };
            addSignal(relationItem, { entityBoost });
            if (
              relation.relationType === "has" &&
              relation.sourceId === objectId
            ) {
              const childItems = await this.source.resolveObjects(
                scopedContext,
                [{ id: relation.targetId, kind: relation.targetKind }],
              );
              for (const child of childItems) {
                addSignal(child, { entityBoost: 0.5 });
              }
              if (
                childItems.length > 0 &&
                resolvedNameScope.has(relation.sourceId)
              ) {
                resolvedNameScope.add(relation.id);
                resolvedNameScope.add(relation.targetId);
                for (const child of childItems) {
                  if (child.kind === "entity") {
                    resolvedNameScope.add(child.entity.id);
                    if (child.branch !== undefined) {
                      resolvedNameScope.add(child.branch.id);
                    }
                  }
                }
              }
            }
            if (
              hit.item.kind !== "entity" ||
              !relationCanPackFromHit(relation, objectId)
            ) {
              continue;
            }
            const relatedEndpoint =
              relation.sourceId === objectId
                ? { id: relation.targetId, kind: relation.targetKind }
                : { id: relation.sourceId, kind: relation.sourceKind };
            const relatedItems = await this.source.resolveObjects(
              scopedContext,
              [relatedEndpoint],
            );
            const packedEntities =
              relatedEndpoint.kind === "memory_entity"
                ? relatedItems
                    .filter(
                      (item): item is EntityRetrievalItem =>
                        item.kind === "entity",
                    )
                    .map((item) => item.entity)
                : [];
            const packedBranches =
              relatedEndpoint.kind === "memory_entity_branch"
                ? relatedItems
                    .filter(
                      (item): item is EntityRetrievalItem =>
                        item.kind === "entity" && item.branch !== undefined,
                    )
                    .map((item) => item.branch as MemoryEntityBranch)
                : [];
            const packedChunks =
              relatedEndpoint.kind === "resource" ||
              relatedEndpoint.kind === "resource_chunk"
                ? relatedItems
                    .filter(
                      (item): item is ResourceChunkRetrievalItem =>
                        item.kind === "resource_chunk",
                    )
                    .map((item) => item.chunk)
                : [];
            const endpointResolved =
              packedEntities.length > 0 ||
              packedBranches.length > 0 ||
              packedChunks.length > 0;
            if (resolvedNameScope.has(objectId)) {
              resolvedNameScope.add(relation.id);
              resolvedNameScope.add(relatedEndpoint.id);
              for (const related of relatedItems) {
                if (related.kind === "entity") {
                  resolvedNameScope.add(related.entity.id);
                  if (related.branch !== undefined) {
                    resolvedNameScope.add(related.branch.id);
                  }
                } else if (related.kind === "resource_chunk") {
                  resolvedNameScope.add(related.chunk.id);
                  resolvedNameScope.add(related.chunk.resourceId);
                }
              }
            }
            if (!endpointResolved) continue;
            addSignal(
              {
                ...cloneItem(hit.item),
                packedRelations: [
                  ...(hit.item.packedRelations ?? []),
                  relation,
                ],
                packedEntities: uniqueById([
                  ...(hit.item.packedEntities ?? []),
                  ...packedEntities,
                ]),
                packedBranches: uniqueById([
                  ...(hit.item.packedBranches ?? []),
                  ...packedBranches,
                ]),
                evidence: uniqueById([
                  ...hit.item.evidence,
                  ...packedChunks,
                ]),
              },
              {
                semantic: hit.semantic,
                bm25: hit.bm25,
                entityBoost,
              },
            );
          }
        }
      }
    }

    const eligibleSignals = [...signals.values()].filter(
      (entry) =>
        entry.semantic === 0 ||
        entry.semantic >= this.semanticCandidateFloor ||
        entry.bm25 > 0 ||
        entry.entityBoost > 0,
    );
    const composites = eligibleSignals
      .map((entry) => entry.item)
      .filter(
        (item): item is EntityRetrievalItem =>
          item.kind === "entity" &&
          (item.packedRelations?.length ?? 0) > 0,
      );
    const fused = eligibleSignals
      .filter((entry) =>
        (entry.item.kind === "entity" &&
          (entry.item.packedRelations?.length ?? 0) > 0) ||
        !composites.some((composite) =>
          compositeContainsFragment(composite, entry.item)
        )
      )
      .map((entry) => ({
        ...entry.item,
        score: fuseScore(entry),
      }) as MemoryRetrievalItem)
      .filter((item) => {
        if (layer === "L3") return item.kind === "entity";
        if (layer === "L2") return item.kind === "entity" || item.kind === "relation";
        return item.kind === "resource_chunk";
      })
      .filter((item) =>
        withinTaskScope(item, context.taskScope) &&
        withinQueryTags(item, query) &&
        withinResolvedNameScope(item, query, resolvedNameScope)
      )
      .sort((left, right) => right.score - left.score);
    const diagnostics: RecallDiagnostics = {
      extractedAtoms,
      laneCandidates,
      semanticCandidateFloor: this.semanticCandidateFloor,
      thresholdPruned: signals.size - eligibleSignals.length,
      relationExpansions: expandedRelationIds.size,
      finalCandidates: fused.length,
    };
    if (layer !== "L3") {
      return {
        items: selectTopP(fused, limit, this.recallTopP),
        diagnostics,
        unresolvedNames,
      };
    }
    const byEntity = new Map<string, EntityRetrievalItem>();
    for (const item of fused) {
      if (item.kind !== "entity") continue;
      const current = byEntity.get(item.entity.id);
      if (current === undefined || item.score > current.score) {
        byEntity.set(item.entity.id, item);
      }
    }
    return {
      items: selectTopP([...byEntity.values()], limit, this.recallTopP),
      diagnostics: {
        ...diagnostics,
        finalCandidates: byEntity.size,
      },
      unresolvedNames,
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
  const payload = point.payload as unknown as Partial<MemoryEntityBranch>;
  return {
    ...(point.payload as unknown as MemoryEntityBranch),
    id:
      (typeof point.payload.entityBranchId === "string"
        ? point.payload.entityBranchId
        : undefined) ?? pointId(point),
    title: typeof payload.title === "string" ? payload.title : pointId(point),
    description:
      typeof payload.description === "string" ? payload.description : "",
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    importance:
      typeof payload.importance === "number" ? payload.importance : 0,
    confidence:
      typeof payload.confidence === "number" ? payload.confidence : 0,
  };
}

function entityRootFilter(
  context: MemoryQueryContext,
  entityIds?: string[],
): VectorMemoryFilter {
  const allowedEntityIds = context.taskScope?.allowedEntityIds;
  const requestEntityIds =
    entityIds === undefined
      ? allowedEntityIds
      : allowedEntityIds === undefined
        ? entityIds
        : entityIds.filter((id) => allowedEntityIds.includes(id));
  return {
    rootEntityId: context.rootEntityId,
    status: "active",
    ...(requestEntityIds === undefined ? {} : { entityId: requestEntityIds }),
    ...(context.taskScope?.allowedTags === undefined
      ? {}
      : { tagsAny: context.taskScope.allowedTags }),
    ...(context.taskScope?.deniedTags === undefined
      ? {}
      : { tagsNone: context.taskScope.deniedTags }),
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
    const [entities, branches, chunkItems] = await Promise.all([
      this.vectors.list({
        collection: "memory_entities",
        filter: entityRootFilter(context),
        limit,
      }),
      this.vectors.list({
        collection: "memory_entity_branches",
        filter: entityFilter(context),
        limit,
      }),
      this.keywordChunks(context, text, limit),
    ]);
    const entityItems = await this.entityItemsForEntities(context, entities);
    const branchEntityItems = await this.entityItemsForBranches(
      context,
      branches,
    );
    const memoryItems = scoreKeywordItems(
      [...entityItems, ...branchEntityItems],
      text,
      limit,
    );
    return [...memoryItems, ...chunkItems]
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  async semanticSearch(
    context: MemoryQueryContext,
    embedding: number[],
    limit = 20,
  ): Promise<MemoryRetrievalItem[]> {
    const [entityPoints, branchPoints, chunkPoints] = await Promise.all([
      this.vectors.search({
        collection: "memory_entities",
        vector: embedding,
        filter: entityRootFilter(context),
        limit,
      }),
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
    const entityItems = [
      ...(await this.entityItemsForEntities(context, entityPoints)),
      ...(await this.entityItemsForBranches(context, branchPoints)),
    ];
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
    const [entities, branches] = await Promise.all([
      this.vectors.list({
        collection: "memory_entities",
        filter: entityRootFilter(context, options.entityIds),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      }),
      this.vectors.list({
        collection: "memory_entity_branches",
        filter: entityFilter(context, options.entityIds),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      }),
    ]);
    const entityItems = await this.entityItemsForEntities(
      context,
      entities.filter((point) => {
        const entity = entityFromPoint(point);
        return (
          options.text === undefined ||
          includesText(entity.name ?? "", options.text) ||
          includesText(entity.title ?? "", options.text) ||
          includesText(entity.description ?? "", options.text) ||
          entity.tags?.some((tag) => includesText(tag, options.text ?? "")) === true
        );
      }),
    );
    const branchItems = await this.entityItemsForBranches(
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
    );
    return [...entityItems, ...branchItems].slice(0, options.limit ?? 20);
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

  async relationsForObject(
    context: MemoryQueryContext,
    options: {
      objectId: string;
      relationTypes?: MemoryRelationType[];
    },
  ): Promise<MemoryRelation[]> {
    const relationTypes = relationTypesForContext(
      context,
      options.relationTypes,
    );
    if (relationTypes?.length === 0) {
      return [];
    }
    const relations = await this.relations.list({
      rootEntityId: context.rootEntityId,
      branchRef: context.branchRef,
      ...(relationTypes === undefined ? {} : { relationTypes }),
      status: "active",
    });
    return relations.filter((relation) => {
      if (
        relation.sourceId !== options.objectId &&
        relation.targetId !== options.objectId
      ) {
        return false;
      }
      const policy = context.taskScope?.relationExpansionPolicy;
      return (
        policy?.allowedRelationTypes === undefined ||
        policy.allowedRelationTypes.includes(relation.relationType)
      );
    });
  }

  async resolveObjects(
    context: MemoryQueryContext,
    objects: Array<{ id: string; kind: RelationEndpointKind }>,
  ): Promise<MemoryRetrievalItem[]> {
    const resolved: MemoryRetrievalItem[] = [];
    for (const object of objects) {
      if (object.kind === "memory_entity") {
        const point = await this.vectors.get("memory_entities", object.id);
        if (point === undefined) continue;
        const entity = entityFromPoint(point);
        if (
          entity.rootEntityId !== context.rootEntityId ||
          entity.status !== "active" ||
          isDeniedEntity(context, entity.id)
        ) {
          continue;
        }
        resolved.push(...await this.entityItemsForEntities(context, [point]));
        continue;
      }
      if (object.kind === "memory_entity_branch") {
        const point = await this.vectors.get("memory_entity_branches", object.id);
        if (point === undefined) continue;
        const branch = branchFromPoint(point);
        if (
          branch.rootEntityId !== context.rootEntityId ||
          branch.branchRef !== context.branchRef ||
          branch.status !== "active" ||
          isDeniedEntity(context, branch.entityId)
        ) {
          continue;
        }
        resolved.push(...await this.entityItemsForBranches(context, [point]));
        continue;
      }
      if (object.kind === "resource_chunk") {
        const point = await this.vectors.get("resource_chunks", object.id);
        if (point === undefined) continue;
        const chunk = chunkFromPoint(point);
        if (
          chunk.rootEntityId !== context.rootEntityId ||
          isDeniedResource(context, chunk.resourceId)
        ) {
          continue;
        }
        resolved.push({
          kind: "resource_chunk",
          chunk,
          score: point.score ?? 1,
          origin: this.origin,
        });
        continue;
      }
      const points = await this.vectors.list({
        collection: "resource_chunks",
        filter: resourceFilter(context),
        limit: 100,
      });
      resolved.push(
        ...points
          .map((point) => ({ point, chunk: chunkFromPoint(point) }))
          .filter(({ chunk }) =>
            chunk.resourceId === object.id &&
            !isDeniedResource(context, chunk.resourceId)
          )
          .map(({ point, chunk }) => ({
            kind: "resource_chunk" as const,
            chunk,
            score: point.score ?? 1,
            origin: this.origin,
          })),
      );
    }
    return [
      ...new Map(
        resolved
          .filter((item) => withinTaskScope(item, context.taskScope))
          .map((item) => [itemKey(item), item]),
      ).values(),
    ];
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

  private async entityItemsForEntities(
    context: MemoryQueryContext,
    points: VectorMemoryPoint[],
  ): Promise<EntityRetrievalItem[]> {
    const items: EntityRetrievalItem[] = [];
    for (const point of points) {
      const entity = entityFromPoint(point);
      if (
        entity.status !== "active" ||
        entity.rootEntityId === null ||
        isDeniedEntity(context, entity.id)
      ) {
        continue;
      }
      const branchPoint = entity.currentBranchId === undefined
        ? undefined
        : await this.vectors.get(
            "memory_entity_branches",
            entity.currentBranchId,
          );
      items.push({
        kind: "entity",
        entity,
        ...(branchPoint === undefined ? {} : { branch: branchFromPoint(branchPoint) }),
        evidence: [],
        score: point.score ?? 1,
        origin: this.origin,
      });
    }
    return items;
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

function includesText(value: unknown, query: string): boolean {
  if (typeof value !== "string") {
    return false;
  }
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
    const entityItems = this.entityItems(view);
    const chunkItems: ResourceChunkRetrievalItem[] = view.resourceChunks
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
    return scoreKeywordItems(
      [...entityItems, ...chunkItems].filter((item) =>
        withinTaskScope(item, context.taskScope)
      ),
      text,
      limit,
    );
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
          item.entity.embedding !== undefined ||
          (item.branch as { embedding?: number[] } | undefined)?.embedding !==
          undefined,
      )
      .map((item) => ({
        ...item,
        score: dotProduct(
          item.entity.embedding ??
            (item.branch as { embedding?: number[] } | undefined)?.embedding ??
            [],
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
            includesText(item.entity.name ?? "", options.text) ||
            includesText(item.entity.title ?? "", options.text) ||
            includesText(item.entity.description ?? "", options.text) ||
            item.entity.tags?.some((tag) =>
              includesText(tag, options.text ?? ""),
            ) === true ||
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

  async relationsForObject(
    context: MemoryQueryContext,
    options: {
      objectId: string;
      relationTypes?: MemoryRelationType[];
    },
  ): Promise<MemoryRelation[]> {
    const view = await this.readView(
      context.rootEntityId,
      context.branchRef,
    );
    const relationTypes = relationTypesForContext(
      context,
      options.relationTypes,
    );
    if (relationTypes?.length === 0) {
      return [];
    }
    return view.relations.filter(
      (relation) =>
        relation.status === "active" &&
        (relation.sourceId === options.objectId ||
          relation.targetId === options.objectId) &&
        (relationTypes === undefined ||
          relationTypes.includes(relation.relationType)),
    );
  }

  async resolveObjects(
    context: MemoryQueryContext,
    objects: Array<{ id: string; kind: RelationEndpointKind }>,
  ): Promise<MemoryRetrievalItem[]> {
    const view = await this.readView(
      context.rootEntityId,
      context.branchRef,
    );
    const resolved: MemoryRetrievalItem[] = [];
    for (const object of objects) {
      if (object.kind === "memory_entity") {
        const item = this.entityItems(view).find(
          (candidate) =>
            candidate.entity.id === object.id &&
            candidate.entity.status === "active",
        );
        if (item !== undefined) resolved.push(item);
        continue;
      }
      if (object.kind === "memory_entity_branch") {
        const branch = view.entityBranches.find(
          (candidate) =>
            candidate.id === object.id &&
            candidate.rootEntityId === context.rootEntityId &&
            candidate.branchRef === context.branchRef &&
            candidate.status !== "tombstoned",
        );
        const entity = branch === undefined
          ? undefined
          : view.entities.find(
              (candidate) =>
                candidate.id === branch.entityId &&
                candidate.status === "active",
            );
        if (branch !== undefined && entity !== undefined) {
          resolved.push({
            kind: "entity",
            entity,
            branch,
            evidence: [],
            score: 1,
            origin:
              this.originFor?.("entity", entity.id) ??
              this.origin,
          });
        }
        continue;
      }
      const chunks = view.resourceChunks.filter((chunk) =>
        object.kind === "resource_chunk"
          ? chunk.id === object.id
          : chunk.resourceId === object.id
      );
      for (const chunk of chunks) {
        const resource = view.resources.find(
          (candidate) => candidate.id === chunk.resourceId,
        );
        resolved.push({
          kind: "resource_chunk",
          chunk,
          ...(resource === undefined ? {} : { resource }),
          score: 1,
          origin:
            this.originFor?.("resource_chunk", chunk.id) ??
            this.origin,
        });
      }
    }
    return [
      ...new Map(
        resolved
          .filter((item) => withinTaskScope(item, context.taskScope))
          .map((item) => [itemKey(item), item]),
      ).values(),
    ];
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
