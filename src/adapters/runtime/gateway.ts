import { randomUUID } from "node:crypto";
import { ResourceConflictError, ResourceNotFoundError } from "../../resources/service.ts";
import {
  CloudAuthorizedViewAdapter,
  ConflictResolutionAdapter,
  InMemoryAuthorizedQuerySource,
  MemoryRetrievalAdapter,
  PermissionRouter,
  type AuthorizedSyncBatch,
  type AuthorizedSyncRequest,
  type CloudMemoryWriteCommand,
  type CloudMemoryWriteResult,
  type ConflictResolutionCommand,
  type ConflictResolutionResult,
  type MemoryAction,
  type MemoryEntity,
  type MemoryEntityBranch,
  type MemoryOperationInput,
  type MemoryObjectKind,
  type MemoryRelation,
  type MemoryRelationType,
  type PermissionWatermarkProvider,
  type MemoryRetrievalRequest,
  type MemoryRetrievalResult,
  type PermissionDecision,
  type PermissionRouteResult,
  type ResourceSourceType,
} from "../../index.ts";
import type { AgentDelegation, User, UserRootRoleAssignment } from "../../contracts/rbac.ts";
import type { AgentType, Permission } from "../../contracts/rbac.ts";
import type { AuthenticatedSession } from "../libsql/rbac-authority.ts";
import type { CreatedSession } from "../libsql/rbac-authority.ts";
import {
  formatInjectedMemoryContext,
  hostCaptureInput,
  hostRecallInput,
  type HostCaptureInput,
  type HostRecallInput,
  type InjectedMemoryContext,
  type MemoryCaptureResult,
} from "../lifecycle/host-memory.ts";
import type { TeamMemoryRuntime } from "./development-stack.ts";

export type GatewayErrorCode =
  | "auth_failed"
  | "permission_denied"
  | "conflict"
  | "validation_failed"
  | "dependency_unavailable"
  | "not_found";

export class TeamMemoryGatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly decision?: PermissionDecision & { allowed: false };

  constructor(
    code: GatewayErrorCode,
    message: string,
    decision?: PermissionDecision & { allowed: false },
  ) {
    super(`${code}: ${message}`);
    this.code = code;
    if (decision !== undefined) this.decision = decision;
  }
}

export interface TeamMemoryGatewayOptions {
  retrieval?: "runtime" | "active-view";
  permissionWatermarks?: PermissionWatermarkProvider;
  projectWrites?: boolean;
  branchDedupeThreshold?: number;
  branchRelationHintThreshold?: number;
}

const forbiddenPayloadFields = new Set([
  "subject",
  "userId",
  "ownerUserId",
  "agentId",
  "rootEntityId",
  "taskScope",
]);

function assertNoIdentityOverride(payload: Record<string, unknown>): void {
  for (const field of forbiddenPayloadFields) {
    if (field in payload) {
      throw new TeamMemoryGatewayError(
        "validation_failed",
        `request payload cannot provide ${field}`,
      );
    }
  }
}

function stringValue(
  payload: Record<string, unknown>,
  key: string,
): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TeamMemoryGatewayError(
      "validation_failed",
      `${key} is required`,
    );
  }
  return value;
}

function objectValue(
  payload: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = payload[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TeamMemoryGatewayError(
      "validation_failed",
      `${key} is required`,
    );
  }
  return value as Record<string, unknown>;
}

function optionalString(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new TeamMemoryGatewayError(
      "validation_failed",
      `${key} must be a non-empty string`,
    );
  }
  return value;
}

function denied<TResult>(
  result: PermissionRouteResult<TResult>,
): PermissionDecision & { allowed: false } | undefined {
  return "value" in result ? undefined : result.decision;
}

function unwrap<TResult>(result: PermissionRouteResult<TResult>): TResult {
  if ("value" in result) return result.value;
  throw new TeamMemoryGatewayError(
    "permission_denied",
    result.decision.reason,
    result.decision,
  );
}

function branchRef(payload: Record<string, unknown>): string {
  return optionalString(payload, "branchRef") ?? "main";
}

function recallSearchText(input: HostRecallInput): string {
  return [
    input.userPrompt,
    ...(input.recentMessages ?? []).slice(-6).map((message) =>
      `${message.role}: ${message.content}`
    ),
    ...(input.resourceHints ?? []),
  ].join("\n");
}

function captureTitle(input: HostCaptureInput): string {
  const subject = input.userPrompt ?? input.finalAssistantMessage ?? input.errorSummary;
  const trimmed = subject?.replace(/\s+/g, " ").trim();
  const suffix = trimmed === undefined || trimmed.length === 0
    ? input.sessionId
    : trimmed.slice(0, 80);
  return `${input.host} ${input.outcome} path: ${suffix}`;
}

function captureDescription(input: HostCaptureInput): string {
  const lines = [
    `Host: ${input.host}`,
    `Session: ${input.sessionId}`,
    `Outcome: ${input.outcome}`,
    input.userPrompt === undefined ? "" : `User prompt: ${input.userPrompt}`,
    input.finalAssistantMessage === undefined
      ? ""
      : `Final assistant message: ${input.finalAssistantMessage}`,
    input.errorSummary === undefined ? "" : `Error summary: ${input.errorSummary}`,
    input.transcriptPath === undefined ? "" : `Transcript: ${input.transcriptPath}`,
    input.toolEvents === undefined
      ? ""
      : `Tool events: ${JSON.stringify(input.toolEvents)}`,
  ];
  return lines.filter((line) => line.length > 0).join("\n");
}

function captureConversationText(input: HostCaptureInput): string {
  const lines = [
    `Host: ${input.host}`,
    `Session: ${input.sessionId}`,
    `Outcome: ${input.outcome}`,
    input.userPrompt === undefined ? "" : `User: ${input.userPrompt}`,
    input.finalAssistantMessage === undefined
      ? ""
      : `Assistant: ${input.finalAssistantMessage}`,
    input.errorSummary === undefined ? "" : `Error: ${input.errorSummary}`,
    input.transcriptPath === undefined ? "" : `Transcript: ${input.transcriptPath}`,
    input.toolEvents === undefined
      ? ""
      : `Tool events: ${JSON.stringify(input.toolEvents)}`,
  ];
  return lines.filter((line) => line.length > 0).join("\n");
}

function compactTitle(value: string | undefined, fallback: string): string {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  if (cleaned === undefined || cleaned.length === 0) return fallback;
  return cleaned.slice(0, 80);
}

function extractLifecycleStructuredOperations(
  input: HostCaptureInput,
  chunkIds: string[],
): Array<Record<string, unknown>> {
  const semanticText = [
    input.userPrompt,
    input.finalAssistantMessage,
    input.errorSummary,
  ].filter((value): value is string => value !== undefined && value.trim().length > 0)
    .join("\n");
  if (semanticText.length === 0) return [];
  const entityName = compactTitle(
    input.title ?? input.userPrompt ?? input.finalAssistantMessage,
    `${input.host} lifecycle memory`,
  );
  const branchName = compactTitle(
    input.finalAssistantMessage ?? input.errorSummary ?? input.userPrompt,
    `${entityName} lifecycle fact`,
  );
  const operations: Array<Record<string, unknown>> = [
    {
      target: "memory_entity",
      op: "create",
      properties: {
        name: entityName,
        title: entityName,
        description: semanticText.slice(0, 500),
        tags: ["lifecycle-extracted", input.host],
      },
    },
    {
      target: "memory_entity_branch",
      op: "create",
      subject: entityName,
      properties: {
        name: branchName,
        title: branchName,
        description: semanticText,
        tags: ["lifecycle-extracted", input.host, input.outcome],
        extra: {
          extractedFrom: "host_lifecycle",
          host: input.host,
          sessionId: input.sessionId,
          outcome: input.outcome,
        },
      },
    },
    ...chunkIds.map((chunkId) => ({
      target: "memory_relation",
      op: "create",
      type: "refers_to",
      subject: {
        target: "memory_entity",
        name: entityName,
      },
      object: {
        target: "resource_chunk",
        name: chunkId,
      },
    })),
  ];
  if (/\b(contradict|contradicts|conflict|conflicts|corrected|correction)\b/i.test(semanticText)) {
    operations.push({
      target: "memory_relation",
      op: "create",
      type: "contradicts",
      subject: {
        target: "memory_entity_branch",
        name: branchName,
        parent: entityName,
      },
      object: {
        target: "memory_entity_branch",
        name: "previous recalled branch",
        parent: entityName,
      },
    });
  }
  return operations;
}

function semanticDescriptionFromLegacyBranch(branch: MemoryEntityBranch): string {
  return branch.description
    .split(/\r?\n/)
    .filter((line) =>
      !/^(Host|Session|Outcome|Transcript|Tool events):/.test(line)
    )
    .map((line) => line.replace(/^User prompt:\s*/, "User: ").replace(/^Final assistant message:\s*/, "Assistant: "))
    .join("\n")
    .trim();
}

function legacyEntityName(branch: MemoryEntityBranch): string {
  return branch.title
    .replace(/^(claude_code|openclaw|hermes)\s+(success|failure|unknown)\s+path:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Migrated host memory";
}

function isLegacyHostCaptureEntity(
  entity: MemoryEntity,
  branches: MemoryEntityBranch[],
): boolean {
  if (entity.id.startsWith("host-capture:")) return true;
  return branches.some((branch) =>
    branch.entityId === entity.id &&
    (
      branch.tags.includes("host-memory") ||
      /^(claude_code|openclaw|hermes)\s+(success|failure|unknown)\s+path:/i.test(branch.title)
    )
  );
}

function numberValue(
  payload: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) {
    throw new TeamMemoryGatewayError(
      "validation_failed",
      `${key} must be an integer`,
    );
  }
  return value as number;
}

function gatewaySubject(session: AuthenticatedSession) {
  return session.subject;
}

function defaultAgentPermissions(ownerPermissions: readonly Permission[]): Permission[] {
  const desired = new Set([
    "read:memory_entity",
    "search:memory_entity",
    "write_entity:memory_entity",
    "write_entity_branch:memory_entity_branch",
    "commit:memory_entity",
    "import_resource:resource",
    "read:resource",
    "search:resource",
    "write_resource_chunk:resource_chunk",
    "index_resource:resource",
    "index_resource:resource_chunk",
  ]);
  return ownerPermissions.filter((permission) =>
    desired.has(`${permission.action}:${permission.resourceKind}`),
  );
}

const agentToolCatalog = [
  {
    name: "memory.catalog",
    description: "List the trusted session root name plus visible MemoryEntity names and tags. Does not expose generated ids.",
    action: "read",
    resourceKind: "memory_entity",
  },
  {
    name: "memory.search",
    description: "Search Team Memory with natural-language query plus optional limit, layer, names, and tagsAny. Identity, root, history toggles, conflict flags, and generated ids are not accepted.",
    action: "search",
    resourceKind: "memory_entity",
  },
  {
    name: "memory.write",
    description: [
      "Capture durable semantic memory with a required operations[] batch.",
      "Extract entity summaries, atomic MemoryEntityBranch facts, and MemoryRelation edges before writing.",
      "Few-shot: new project -> memory_entity/create then memory_entity_branch/create; summary refresh -> memory_entity/refresh; duplicate fact -> memory_entity_branch/create lets branch vector dedupe update metadata; related fact -> memory_relation/create with type relates_to; conflict -> memory_entity_branch/create for the new fact plus memory_relation/create with type contradicts between old/new natural-name endpoints in the same call.",
      "Do not send raw transcript-as-memory, Agent-authored ResourceChunk, clientMutationId, branchRef, expectedHeadCommitId, top-level payload.conflict, generated ids, identity/root fields, embeddings, provenance, or outcome-as-semantic-content.",
    ].join(" "),
    action: "commit",
    resourceKind: "memory_entity",
  },
] as const;

function stableToolSchema(toolName: string): {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
} {
  if (toolName === "memory.search") {
    return {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
        layer: { type: "string", enum: ["L1", "L2", "L3"] },
        names: { type: "array", items: { type: "string" } },
        tagsAny: { type: "array", items: { type: "string" } },
      },
      required: ["query"],
      additionalProperties: false,
    };
  }
  if (toolName === "memory.write") {
    return {
      type: "object",
      properties: {
        operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              target: {
                type: "string",
                enum: [
                  "memory_entity",
                  "memory_entity_branch",
                  "memory_relation",
                  "resource",
                ],
              },
              op: {
                type: "string",
                enum: [
                  "create",
                  "update",
                  "refresh",
                  "update_metadata",
                  "replace",
                ],
              },
              type: {
                type: "string",
                enum: [
                  "has",
                  "depends_on",
                  "relates_to",
                  "refers_to",
                  "contradicts",
                  "supersedes",
                  "next_is",
                ],
              },
              subject: {
                type: "object",
                properties: {
                  target: {
                    type: "string",
                    enum: [
                      "memory_entity",
                      "memory_entity_branch",
                      "resource",
                      "resource_chunk",
                    ],
                  },
                  name: { type: "string" },
                  parent: { type: "string" },
                },
                additionalProperties: false,
              },
              object: {
                type: "object",
                properties: {
                  target: {
                    type: "string",
                    enum: [
                      "memory_entity",
                      "memory_entity_branch",
                      "resource",
                      "resource_chunk",
                    ],
                  },
                  name: { type: "string" },
                  parent: { type: "string" },
                },
                additionalProperties: false,
              },
              name: { type: "string" },
              properties: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  title: { type: "string" },
                  desc: { type: "string" },
                  description: { type: "string" },
                  tags: { type: "array", items: { type: "string" } },
                  status: { type: "string" },
                  extra: { type: "object" },
                  extraInfo: { type: "object" },
                  content: { type: "string" },
                  contentBase64: { type: "string" },
                  lineRange: {
                    type: "object",
                    properties: {
                      start: { type: "integer" },
                      end: { type: "integer" },
                    },
                    required: ["start", "end"],
                    additionalProperties: false,
                  },
                  replaceMode: { type: "string", enum: ["whole_resource"] },
                },
                additionalProperties: false,
              },
            },
            required: ["target", "op"],
            additionalProperties: false,
          },
        },
      },
      required: ["operations"],
      additionalProperties: false,
    };
  }
  return {
    type: "object",
    properties: {},
    additionalProperties: false,
  };
}

const stableCatalogFields = new Set<string>();
const stableSearchFields = new Set([
  "query",
  "limit",
  "layer",
  "names",
  "tagsAny",
]);
const stableWriteFields = new Set(["operations"]);
const validTargetKinds = new Set([
  "memory_entity",
  "memory_entity_branch",
  "resource",
  "memory_relation",
]);
const systemManagedPatchFields = new Set([
  "id",
  "rootEntityId",
  "entityId",
  "resourceId",
  "revisionId",
  "branchId",
  "relationId",
  "sourceMetadata",
  "session",
  "sessionId",
  "provenance",
  "host",
  "createdAt",
  "updatedAt",
  "embedding",
  "embeddings",
  "bm25",
  "bm25DocumentId",
  "keywords",
  "generatedKeywords",
  "contentHash",
  "payload",
  "conflict",
  "clientMutationId",
  "branchRef",
  "expectedHeadCommitId",
  "commitId",
  "operationId",
]);
const entityPatchFields = new Set(["name", "title", "description", "tags", "status"]);
const branchPatchFields = new Set([...entityPatchFields, "extraInfo"]);
const relationPatchFields = new Set([
  "name",
  "title",
  "description",
  "tags",
  "status",
  "sourceId",
  "targetId",
  "relationType",
]);
const resourcePatchFields = new Set([
  "content",
  "contentBase64",
  "lineRange",
  "replaceMode",
]);

type StableTargetKind =
  | "memory_entity"
  | "memory_entity_branch"
  | "resource"
  | "memory_relation";

type AmbiguousTargetKind = StableTargetKind | "resource_chunk";

interface StableTarget {
  kind: StableTargetKind;
  name: string;
}

interface AmbiguousTarget {
  kind: AmbiguousTargetKind;
  name: string;
}

interface StableWriteResult {
  status: "captured" | "duplicate" | "ambiguous";
  entityId?: string;
  branchId?: string;
  relationId?: string;
  resourceId?: string;
  revisionId?: string;
  commitIds: string[];
  extra: Record<string, unknown>;
}

interface RelatedMemoryCandidate {
  kind: "memory_entity_branch";
  parent: string;
  name: string;
  desc: string;
  tags: string[];
  similarity: number;
  extra?: Record<string, unknown>;
  recommendation: {
    action: "create_memory_relation";
    reason: "similarity_below_dedupe_threshold";
    suggestedTypes: Array<Extract<MemoryRelationType, "relates_to" | "supersedes" | "contradicts">>;
    subject: CanonicalMemoryEndpoint;
    object: CanonicalMemoryEndpoint;
  };
}

type CanonicalMemoryOperationTarget =
  | "memory_entity"
  | "memory_entity_branch"
  | "memory_relation"
  | "resource";

type CanonicalMemoryEndpointTarget =
  | "memory_entity"
  | "memory_entity_branch"
  | "resource"
  | "resource_chunk";

type CanonicalMemoryOperation = {
  target: CanonicalMemoryOperationTarget;
  op: "create" | "update" | "refresh" | "update_metadata" | "replace";
  name?: string;
  type?: MemoryRelationType;
  subject?: CanonicalMemoryEndpoint | string;
  object?: CanonicalMemoryEndpoint | string;
  properties?: Record<string, unknown>;
};

interface CanonicalMemoryEndpoint {
  target: CanonicalMemoryEndpointTarget;
  name: string;
  parent?: string;
}

type ResourceWriteOperation = CanonicalMemoryOperation & {
  target: "resource";
  name: string;
  properties: Record<string, unknown>;
};

type StructuredMemoryOperation =
  | {
      op: "upsert_memory_entity";
      name: string;
      title?: string;
      description?: string;
      tags?: string[];
      status?: string;
    }
  | {
      op: "update_memory_entity" | "refresh_memory_entity_summary";
      name: string;
      title?: string;
      description?: string;
      tags?: string[];
      status?: string;
    }
  | {
      op: "create_memory_entity_branch";
      entityName: string;
      name?: string;
      title?: string;
      description: string;
      tags?: string[];
      status?: string;
      extraInfo?: Record<string, unknown>;
      importance?: number;
      confidence?: number;
    }
  | {
      op: "update_memory_entity_branch_metadata";
      entityName: string;
      name: string;
      tags?: string[];
      status?: string;
      extraInfo?: Record<string, unknown>;
      importance?: number;
      confidence?: number;
    }
  | {
      op: "create_memory_relation" | "replace_memory_relation";
      relationType: MemoryRelationType;
      source: StructuredEndpoint;
      target: StructuredEndpoint;
      description?: string;
      role?: string;
      ordinal?: number;
      required?: boolean;
      weight?: number;
      confidence?: number;
    }
  | {
      op: "link_evidence";
      source: StructuredEndpoint;
      target: StructuredEndpoint;
      description?: string;
    };

interface StructuredEndpoint {
  kind: "memory_entity" | "memory_entity_branch" | "resource" | "resource_chunk";
  name?: string;
  entityName?: string;
}

interface PlannedMemoryWrite {
  status: "ready";
  commitId: string;
  operations: MemoryOperationInput[];
  entityId?: string;
  branchId?: string;
  relationId?: string;
  extra: Record<string, unknown>;
}

function isStableWriteResult(
  value: unknown,
): value is StableWriteResult {
  return (
    value !== null &&
    typeof value === "object" &&
    "commitIds" in value
  );
}

function assertOnlyFields(
  payload: Record<string, unknown>,
  allowed: Set<string>,
  surface: string,
): void {
  for (const field of Object.keys(payload)) {
    if (!allowed.has(field)) {
      throw new TeamMemoryGatewayError(
        "validation_failed",
        `${surface} payload cannot provide ${field}`,
      );
    }
  }
}

function optionalStringList(
  payload: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new TeamMemoryGatewayError(
      "validation_failed",
      `${key} must be an array of non-empty strings`,
    );
  }
  return value;
}

function optionalRecallLayer(
  payload: Record<string, unknown>,
): "L1" | "L2" | "L3" | undefined {
  const value = payload.layer;
  if (value === undefined) return undefined;
  if (value === "L1" || value === "L2" || value === "L3") {
    return value;
  }
  throw new TeamMemoryGatewayError(
    "validation_failed",
    "layer must be L1, L2, or L3",
  );
}

function stableWriteTarget(payload: Record<string, unknown>): StableTarget {
  const target = objectValue(payload, "target");
  assertOnlyFields(target, new Set(["kind", "name"]), "memory.write target");
  const kind = stringValue(target, "kind");
  if (!validTargetKinds.has(kind)) {
    throw new TeamMemoryGatewayError(
      "validation_failed",
      "target.kind must be memory_entity, memory_entity_branch, resource, or memory_relation",
    );
  }
  return {
    kind: kind as StableTargetKind,
    name: stringValue(target, "name"),
  };
}

function patchFieldsFor(kind: StableTargetKind): Set<string> {
  if (kind === "memory_entity") return entityPatchFields;
  if (kind === "memory_entity_branch") return branchPatchFields;
  if (kind === "resource") return resourcePatchFields;
  return relationPatchFields;
}

function stablePatch(
  target: StableTarget,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const patch = objectValue(payload, "patch");
  const allowed = patchFieldsFor(target.kind);
  for (const field of Object.keys(patch)) {
    if (systemManagedPatchFields.has(field) || !allowed.has(field)) {
      throw new TeamMemoryGatewayError(
        "validation_failed",
        `memory.write patch cannot provide ${field}`,
      );
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new TeamMemoryGatewayError(
      "validation_failed",
      "patch must contain at least one field",
    );
  }
  return patch;
}

function optionalTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new TeamMemoryGatewayError(
      "validation_failed",
      "tags must be an array of non-empty strings",
    );
  }
  return value;
}

function optionalStatus<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field = "status",
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new TeamMemoryGatewayError(
    "validation_failed",
    `${field} is not valid for target.kind`,
  );
}

function optionalRelationType(value: unknown): MemoryRelationType | undefined {
  if (value === undefined) return undefined;
  if (
    value === "has" ||
    value === "depends_on" ||
    value === "relates_to" ||
    value === "refers_to" ||
    value === "contradicts" ||
    value === "supersedes" ||
    value === "next_is"
  ) {
    return value;
  }
  throw new TeamMemoryGatewayError(
    "validation_failed",
    "relationType is not valid",
  );
}

function optionalNumberField(
  payload: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TeamMemoryGatewayError(
      "validation_failed",
      `${key} must be a finite number`,
    );
  }
  return value;
}

function stableName(branch: MemoryEntityBranch | undefined, fallback: string): string {
  return branch?.title ?? fallback;
}

function normalizedBranchTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function entityVisibleName(
  entity: MemoryEntity,
  branch?: MemoryEntityBranch,
): string {
  return entity.name ?? entity.title ?? branch?.title ?? entity.id;
}

function entityVisibleSummary(
  entity: MemoryEntity,
  branch?: MemoryEntityBranch,
): string {
  return entity.description ?? branch?.description ?? "";
}

function entityVisibleTags(
  entity: MemoryEntity,
  branch?: MemoryEntityBranch,
): string[] {
  return [...(entity.tags ?? branch?.tags ?? [])];
}

function dotProduct(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let score = 0;
  for (let index = 0; index < length; index += 1) {
    score += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return score;
}

function vectorMagnitude(vector: number[]): number {
  return Math.hypot(...vector) || 1;
}

function cosineSimilarity(left: number[], right: number[]): number {
  return dotProduct(left, right) / (vectorMagnitude(left) * vectorMagnitude(right));
}

function descriptionFromPatch(patch: Record<string, unknown>): string {
  const value = patch.description;
  return typeof value === "string" ? value : "";
}

function assertNoSystemManagedInput(
  payload: Record<string, unknown>,
  surface: string,
): void {
  for (const field of Object.keys(payload)) {
    if (
      systemManagedPatchFields.has(field) ||
      (field !== "subject" && forbiddenPayloadFields.has(field)) ||
      field === "payload" ||
      field === "conflict"
    ) {
      throw new TeamMemoryGatewayError(
        "validation_failed",
        `${surface} cannot provide ${field}`,
      );
    }
  }
}

export class TeamMemoryGateway {
  private readonly runtime: TeamMemoryRuntime;
  private readonly writeRouter: PermissionRouter<
    CloudMemoryWriteResult,
    CloudMemoryWriteCommand
  >;
  private readonly retrievalRouter: PermissionRouter<
    MemoryRetrievalResult,
    MemoryRetrievalRequest
  >;
  private readonly resolutionRouter: PermissionRouter<
    ConflictResolutionResult,
    ConflictResolutionCommand
  >;
  private readonly syncRouter: PermissionRouter<
    AuthorizedSyncBatch,
    AuthorizedSyncRequest
  >;
  private readonly projectWrites: boolean;
  private readonly branchDedupeThreshold: number;
  private readonly branchRelationHintThreshold: number;

  constructor(
    runtime: TeamMemoryRuntime,
    options: TeamMemoryGatewayOptions = {},
  ) {
    this.runtime = runtime;
    this.projectWrites = options.projectWrites ?? true;
    this.branchDedupeThreshold = options.branchDedupeThreshold ?? 0.92;
    this.branchRelationHintThreshold = Math.min(
      options.branchRelationHintThreshold ?? 0.82,
      this.branchDedupeThreshold,
    );
    this.writeRouter = new PermissionRouter(runtime.policy, runtime.history);
    this.retrievalRouter =
      options.retrieval === "active-view"
        ? new PermissionRouter(
            runtime.policy,
            new MemoryRetrievalAdapter(
              new InMemoryAuthorizedQuerySource(
                (rootEntityId, branch) =>
                  runtime.history.readActiveView(rootEntityId, branch),
                "cloud_active",
              ),
              {
                embeddings: runtime.embeddings,
                recallTopP: runtime.recallTopP,
              },
            ),
          )
        : runtime.retrieval;
    this.resolutionRouter = new PermissionRouter(
      runtime.policy,
      new ConflictResolutionAdapter(runtime.history),
    );
    this.syncRouter = new PermissionRouter(
      runtime.policy,
      new CloudAuthorizedViewAdapter(
        runtime.history,
        options.permissionWatermarks ?? runtime.rbac,
      ),
    );
  }

  async authenticate(token: string | undefined): Promise<AuthenticatedSession> {
    if (token === undefined || token.length === 0) {
      throw new TeamMemoryGatewayError("auth_failed", "missing bearer token");
    }
    const session = await this.runtime.rbac.authenticate(token);
    if (session === undefined) {
      throw new TeamMemoryGatewayError("auth_failed", "invalid session");
    }
    return session;
  }

  async identity(token: string | undefined): Promise<{
    sessionId: string;
    userId: string;
    agentId?: string;
    rootEntityId: string;
    delegationId?: string;
    provider: {
      mode: "runtime";
      trustedRootEntityId: string;
      visibleTools: string[];
      tokenAvailable: boolean;
      sessionAvailable: boolean;
    };
  }> {
    const session = await this.authenticate(token);
    const visibleTools = await this.visibleToolNamesForSession(session);
    return {
      sessionId: session.sessionId,
      userId: session.userId,
      ...(session.agentId === undefined ? {} : { agentId: session.agentId }),
      rootEntityId: session.rootEntityId,
      ...(session.delegationId === undefined
        ? {}
        : { delegationId: session.delegationId }),
      provider: {
        mode: "runtime",
        trustedRootEntityId: session.rootEntityId,
        visibleTools,
        tokenAvailable: true,
        sessionAvailable: true,
      },
    };
  }

  private async projectMemoryIfEnabled(
    rootEntityId: string,
    branchRef: string,
  ): Promise<void> {
    if (this.projectWrites) {
      await this.runtime.projectMemory(rootEntityId, branchRef);
    }
  }

  private async visibleToolNamesForSession(
    session: AuthenticatedSession,
  ): Promise<string[]> {
    const visible: string[] = [];
    for (const tool of agentToolCatalog) {
      if (session.subject.kind !== "agent") {
        visible.push(tool.name);
        continue;
      }
      const decision = await this.runtime.policy.decide({
        subject: session.subject,
        rootEntityId: session.rootEntityId,
        taskScope: session.taskScope,
        action: tool.action,
        resourceKind: tool.resourceKind,
      });
      if (decision.allowed) {
        visible.push(tool.name);
      }
    }
    return visible;
  }

  async listAgentTools(token: string | undefined): Promise<Array<{
    name: string;
    description: string;
    inputSchema: ReturnType<typeof stableToolSchema>;
  }>> {
    const visible = [];
    for (const tool of agentToolCatalog) {
      const decision = await this.authorizeAgentTool(token, tool.name);
      if (decision.allowed) {
        visible.push({
          name: tool.name,
          description: tool.description,
          inputSchema: stableToolSchema(tool.name),
        });
      }
    }
    return visible;
  }

  async authorizeAgentTool(
    token: string | undefined,
    toolName: string,
  ): Promise<PermissionDecision> {
    const session = await this.authenticate(token);
    const tool = agentToolCatalog.find((candidate) => candidate.name === toolName);
    if (tool === undefined) {
      throw new TeamMemoryGatewayError("validation_failed", `unknown tool: ${toolName}`);
    }
    if (session.subject.kind !== "agent") {
      return {
        allowed: false,
        reason: "agent_session_required",
        subjectId: session.userId,
        subjectKind: session.subject.kind,
        rootEntityId: session.rootEntityId,
        action: tool.action,
        resourceKind: tool.resourceKind,
        matchedRoles: [],
        missingActions: [tool.action],
        constraints: {},
      };
    }
    return this.runtime.policy.decide({
      subject: session.subject,
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      action: tool.action,
      resourceKind: tool.resourceKind,
    });
  }

  async listRoots(token: string | undefined): Promise<{ roots: string[] }> {
    const session = await this.authenticate(token);
    const decision = await this.runtime.policy.decide({
      subject: session.subject,
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      action: "read",
      resourceKind: "memory_entity",
    });
    if (!decision.allowed) {
      throw new TeamMemoryGatewayError(
        "permission_denied",
        decision.reason,
        decision as PermissionDecision & { allowed: false },
      );
    }
    return { roots: [session.rootEntityId] };
  }

  async listMembers(token: string | undefined): Promise<{
    assignments: UserRootRoleAssignment[];
  }> {
    const session = await this.requireHumanAdmin(token, "assign_user_role");
    return {
      assignments: await this.runtime.rbac.listRootAssignments(
        session.rootEntityId,
      ),
    };
  }

  async createMember(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<{
    user: User;
    assignment?: UserRootRoleAssignment;
  }> {
    const session = await this.authenticate(token);
    return this.runtime.admin.createUser(session, {
      userId: stringValue(payload, "userId"),
      displayName: stringValue(payload, "displayName"),
      password: stringValue(payload, "password"),
      ...(optionalString(payload, "roleId") === undefined
        ? {}
        : { roleId: optionalString(payload, "roleId") as string }),
    });
  }

  async assignRole(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<UserRootRoleAssignment> {
    const session = await this.authenticate(token);
    return this.runtime.admin.assignRole(session, {
      id: stringValue(payload, "assignmentId"),
      userId: stringValue(payload, "userId"),
      rootEntityId: session.rootEntityId,
      roleId: stringValue(payload, "roleId"),
    });
  }

  async revokeRole(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<{ status: "revoked" }> {
    const session = await this.authenticate(token);
    await this.runtime.admin.revokeRole(session, {
      assignmentId: stringValue(payload, "assignmentId"),
      userId: stringValue(payload, "userId"),
    });
    return { status: "revoked" };
  }

  async listDelegations(token: string | undefined): Promise<{
    delegations: AgentDelegation[];
  }> {
    const session = await this.requireHumanAdmin(token, "assign_user_role");
    return {
      delegations: await this.runtime.rbac.listRootDelegations(
        session.rootEntityId,
      ),
    };
  }

  async createDelegation(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<AgentDelegation> {
    const session = await this.authenticate(token);
    const agentId = optionalString(payload, "agentId");
    return this.runtime.admin.createDelegation(session, {
      id: stringValue(payload, "delegationId"),
      ...(agentId === undefined ? {} : { agentId }),
      rootEntityId: session.rootEntityId,
      permissions: (payload.permissions as AgentDelegation["permissions"] | undefined) ?? [],
      ...(optionalString(payload, "expiresAt") === undefined
        ? {}
        : { expiresAt: optionalString(payload, "expiresAt") as string }),
    });
  }

  async onboardAgent(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<{
    agentId: string;
    delegationId: string;
    session: CreatedSession;
  }> {
    const session = await this.requireHumanAdmin(token, "assign_user_role");
    const now = new Date().toISOString();
    const agentId = stringValue(payload, "agentId");
    const delegationId = stringValue(payload, "delegationId");
    const sessionId = stringValue(payload, "sessionId");
    const expiresAt = stringValue(payload, "sessionExpiresAt");
    const agentType = (optionalString(payload, "agentType") ?? "curator_agent") as AgentType;
    await this.runtime.rbac.saveAgent({
      id: agentId,
      ownerUserId: session.userId,
      agentType,
      displayName: optionalString(payload, "displayName") ?? agentId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const ownerPermissions = await this.effectiveUserPermissions(
      session.userId,
      session.rootEntityId,
    );
    await this.runtime.admin.createDelegation(session, {
      id: delegationId,
      agentId,
      rootEntityId: session.rootEntityId,
      permissions: (payload.permissions as Permission[] | undefined) ??
        defaultAgentPermissions(ownerPermissions),
      ...(optionalString(payload, "delegationExpiresAt") === undefined
        ? {}
        : { expiresAt: optionalString(payload, "delegationExpiresAt") as string }),
    });
    return {
      agentId,
      delegationId,
      session: await this.runtime.rbac.createSession({
        id: sessionId,
        userId: session.userId,
        agentId,
        delegationId,
        rootEntityId: session.rootEntityId,
        taskScope: { rootEntityId: session.rootEntityId },
        expiresAt,
        createdAt: now,
      }),
    };
  }

  private async effectiveUserPermissions(
    userId: string,
    rootEntityId: string,
  ): Promise<Permission[]> {
    const assignments = await this.runtime.rbac.listUserRootRoleAssignments(
      userId,
      rootEntityId,
    );
    const roles = await Promise.all(
      assignments
        .filter((assignment) => assignment.status === "active")
        .map((assignment) => this.runtime.rbac.getRole(assignment.roleId)),
    );
    return roles.flatMap((role) => role?.permissions ?? []);
  }

  async revokeDelegation(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<{ status: "revoked" }> {
    const session = await this.authenticate(token);
    await this.runtime.admin.revokeDelegation(session, {
      delegationId: stringValue(payload, "delegationId"),
      ...(optionalString(payload, "agentId") === undefined
        ? {}
        : { agentId: optionalString(payload, "agentId") as string }),
    });
    return { status: "revoked" };
  }

  async syncStatus(token: string | undefined): Promise<{
    rootEntityId: string;
    commitWatermark: number;
    headCommitId?: string;
  }> {
    const session = await this.authenticate(token);
    const branch = "main";
    const decision = await this.runtime.policy.decide({
      subject: session.subject,
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      branchRef: branch,
      action: "read",
      resourceKind: "memory_entity",
    });
    if (!decision.allowed) {
      throw new TeamMemoryGatewayError(
        "permission_denied",
        decision.reason,
        decision as PermissionDecision & { allowed: false },
      );
    }
    const headCommitId = this.runtime.history.headCommitId(
      session.rootEntityId,
      branch,
    );
    return {
      rootEntityId: session.rootEntityId,
      commitWatermark: this.runtime.history.commitWatermark(),
      ...(headCommitId === undefined ? {} : { headCommitId }),
    };
  }

  async health(): Promise<{ live: true; ready: boolean; checks: Record<string, string> }> {
    try {
      await this.runtime.ready();
      return { live: true, ready: true, checks: { runtime: "ready" } };
    } catch (error) {
      return {
        live: true,
        ready: false,
        checks: {
          runtime: error instanceof Error ? error.message : "unknown error",
        },
      };
    }
  }

  async createRoot(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<{ status: "created" }> {
    assertNoIdentityOverride(payload);
    const session = await this.authenticate(token);
    await this.runtime.createRootEntity(session, {
      rootEntityId: stringValue(payload, "newRootEntityId"),
      clientMutationId: stringValue(payload, "clientMutationId"),
    });
    return { status: "created" };
  }

  private async requireHumanAdmin(
    token: string | undefined,
    action: MemoryAction,
  ): Promise<AuthenticatedSession> {
    const session = await this.authenticate(token);
    if (session.subject.kind !== "user") {
      throw new TeamMemoryGatewayError(
        "permission_denied",
        "agents cannot perform administrator actions",
      );
    }
    const decision = await this.runtime.policy.decide({
      subject: session.subject,
      rootEntityId: session.rootEntityId,
      action,
      resourceKind: "memory_entity",
    });
    if (!decision.allowed) {
      throw new TeamMemoryGatewayError(
        "permission_denied",
        decision.reason,
        decision as PermissionDecision & { allowed: false },
      );
    }
    return session;
  }

  async migrateLegacyHostCaptures(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<{
    status: "migrated";
    migratedEntityIds: string[];
    tombstonedEntityIds: string[];
    commitIds: string[];
    operations: Array<Record<string, unknown>>;
  }> {
    assertNoIdentityOverride(payload);
    const session = await this.requireHumanAdmin(token, "tombstone_entity");
    const branch = branchRef(payload);
    const view = this.runtime.history.readActiveView(session.rootEntityId, branch);
    const legacyEntities = view.entities
      .filter((entity) => entity.rootEntityId !== null && entity.status === "active")
      .filter((entity) => isLegacyHostCaptureEntity(entity, view.entityBranches));
    if (legacyEntities.length === 0) {
      return {
        status: "migrated",
        migratedEntityIds: [],
        tombstonedEntityIds: [],
        commitIds: [],
        operations: [],
      };
    }

    const relationTargetsByEntityId = new Map<string, string[]>();
    for (const relation of view.relations) {
      if (
        relation.sourceKind === "memory_entity" &&
        relation.targetKind === "resource_chunk" &&
        relation.status === "active"
      ) {
        const targets = relationTargetsByEntityId.get(relation.sourceId) ?? [];
        targets.push(relation.targetId);
        relationTargetsByEntityId.set(relation.sourceId, targets);
      }
    }

    const structuredOperations: Array<Record<string, unknown>> = [];
    const seenBranchByEntityName = new Map<string, string>();
    for (const entity of legacyEntities) {
      const branches = view.entityBranches.filter((candidate) => candidate.entityId === entity.id);
      for (const legacyBranch of branches) {
        const description = semanticDescriptionFromLegacyBranch(legacyBranch);
        if (description.length === 0) continue;
        const entityName = legacyEntityName(legacyBranch);
        const branchName = compactTitle(description, legacyBranch.title);
        structuredOperations.push(
          {
            target: "memory_entity",
            op: "create",
            properties: {
              name: entityName,
              title: entityName,
              description: description.slice(0, 500),
              tags: legacyBranch.tags.filter((tag) =>
                tag !== "host-memory" &&
                tag !== "success" &&
                tag !== "failure" &&
                tag !== "unknown"
              ),
            },
          },
          {
            target: "memory_entity_branch",
            op: "create",
            subject: entityName,
            properties: {
              name: branchName,
              title: branchName,
              description,
              tags: ["migrated-host-capture"],
              extra: {
                migratedFromEntityId: entity.id,
                migratedFromBranchId: legacyBranch.id,
              },
            },
          },
        );
        for (const chunkId of relationTargetsByEntityId.get(entity.id) ?? []) {
          structuredOperations.push({
            target: "memory_relation",
            op: "create",
            type: "refers_to",
            subject: {
              target: "memory_entity",
              name: entityName,
            },
            object: {
              target: "resource_chunk",
              name: chunkId,
            },
          });
        }
        const previousBranch = seenBranchByEntityName.get(entityName);
        if (
          previousBranch !== undefined &&
          /\b(contradict|contradicts|conflict|conflicts|corrected|correction)\b/i.test(description)
        ) {
          structuredOperations.push({
            target: "memory_relation",
            op: "create",
            type: "contradicts",
            subject: {
              target: "memory_entity_branch",
              name: branchName,
              parent: entityName,
            },
            object: {
              target: "memory_entity_branch",
              name: previousBranch,
              parent: entityName,
            },
          });
        }
        seenBranchByEntityName.set(entityName, branchName);
      }
    }

    const commitIds: string[] = [];
    if (structuredOperations.length > 0) {
      const structured = await this.writeMemory(token, {
        operations: structuredOperations,
      });
      commitIds.push(...structured.commitIds);
    }

    const tombstoneCommitId = `commit:migrate-legacy-host-capture:tombstone:${randomUUID()}`;
    const tombstoneOperations: MemoryOperationInput[] = legacyEntities.map((entity, index) => ({
      kind: "tombstone_entity",
      id: `operation:${tombstoneCommitId}:${index}`,
      targetId: entity.id,
    }));
    const decision = await this.runtime.policy.decide({
      subject: session.subject,
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      branchRef: branch,
      action: "tombstone_entity",
      resourceKind: "memory_entity",
    });
    if (!decision.allowed) {
      throw new TeamMemoryGatewayError(
        "permission_denied",
        decision.reason,
        decision as PermissionDecision & { allowed: false },
      );
    }
    const tombstone = await this.runtime.history.execute({
      subject: session.subject,
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      branchRef: branch,
      ...(() => {
        const head = this.runtime.history.headCommitId(session.rootEntityId, branch);
        return head === undefined ? {} : { expectedHeadCommitId: head };
      })(),
      action: "tombstone_entity",
      resourceKind: "memory_entity",
      clientMutationId: `migrate-legacy-host-capture:tombstone:${randomUUID()}`,
      commit: {
        id: tombstoneCommitId,
        message: "Tombstone legacy host-capture entities",
      },
      operation: tombstoneOperations[0] as MemoryOperationInput,
      operations: tombstoneOperations,
      authorization: decision as typeof decision & { allowed: true },
    });
    if (tombstone.status === "conflict") {
      throw new TeamMemoryGatewayError("conflict", tombstone.conflict.id);
    }
    commitIds.push(tombstone.write.commit.id);
    await this.projectMemoryIfEnabled(session.rootEntityId, branch);
    return {
      status: "migrated",
      migratedEntityIds: legacyEntities.map((entity) => entity.id),
      tombstonedEntityIds: legacyEntities.map((entity) => entity.id),
      commitIds,
      operations: structuredOperations,
    };
  }

  async importResource(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    assertNoIdentityOverride(payload);
    const session = await this.authenticate(token);
    const content =
      typeof payload.content === "string"
        ? payload.content
        : Buffer.from(stringValue(payload, "contentBase64"), "base64");
    const imported = await this.runtime.resources.import(session, {
      clientMutationId: stringValue(payload, "clientMutationId"),
      ...(typeof payload.resourceId === "string"
        ? { resourceId: payload.resourceId }
        : {}),
      ...(typeof payload.revisionId === "string"
        ? { revisionId: payload.revisionId }
        : {}),
      ...(typeof payload.commitId === "string"
        ? { commitId: payload.commitId }
        : {}),
      ...(typeof payload.branchRef === "string"
        ? { branchRef: payload.branchRef }
        : {}),
      ...(typeof payload.expectedHeadCommitId === "string"
        ? { expectedHeadCommitId: payload.expectedHeadCommitId }
        : {}),
      title: stringValue(payload, "title"),
      sourceType: stringValue(payload, "sourceType") as ResourceSourceType,
      content,
      ...(typeof payload.uri === "string" ? { uri: payload.uri } : {}),
      ...(typeof payload.metadata === "object" && payload.metadata !== null
        ? { metadata: payload.metadata as Record<string, unknown> }
        : {}),
    });
    return {
      ...imported,
      ingestion: await this.tryAutomaticIngestion(session, {
        resourceId: imported.resource.id,
        branchRef: typeof payload.branchRef === "string" ? payload.branchRef : "main",
        clientMutationId: `${stringValue(payload, "clientMutationId")}:auto-ingest`,
        ...(imported.resource.currentRevisionId === undefined
          ? {}
          : { revisionId: imported.resource.currentRevisionId }),
        ...(typeof payload.maxChunkCharacters === "number"
          ? { maxChunkCharacters: payload.maxChunkCharacters }
          : {}),
      }),
    };
  }

  async reviseResource(
    token: string | undefined,
    resourceId: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    assertNoIdentityOverride(payload);
    const session = await this.authenticate(token);
    const content =
      typeof payload.content === "string"
        ? payload.content
        : Buffer.from(stringValue(payload, "contentBase64"), "base64");
    const revised = await this.runtime.resources.revise(session, {
      clientMutationId: stringValue(payload, "clientMutationId"),
      resourceId,
      content,
      ...(typeof payload.revisionId === "string"
        ? { revisionId: payload.revisionId }
        : {}),
      ...(typeof payload.commitId === "string"
        ? { commitId: payload.commitId }
        : {}),
      ...(typeof payload.branchRef === "string"
        ? { branchRef: payload.branchRef }
        : {}),
      ...(typeof payload.expectedHeadCommitId === "string"
        ? { expectedHeadCommitId: payload.expectedHeadCommitId }
        : {}),
      ...(typeof payload.metadata === "object" && payload.metadata !== null
        ? { metadata: payload.metadata as Record<string, unknown> }
        : {}),
    });
    return {
      ...revised,
      ingestion: await this.tryAutomaticIngestion(session, {
        resourceId,
        revisionId: revised.revisionId,
        branchRef: typeof payload.branchRef === "string" ? payload.branchRef : "main",
        clientMutationId: `${stringValue(payload, "clientMutationId")}:auto-ingest`,
        ...(typeof payload.maxChunkCharacters === "number"
          ? { maxChunkCharacters: payload.maxChunkCharacters }
          : {}),
      }),
    };
  }

  private async tryAutomaticIngestion(
    session: AuthenticatedSession,
    input: {
      resourceId: string;
      revisionId?: string;
      branchRef: string;
      clientMutationId: string;
      maxChunkCharacters?: number;
    },
  ): Promise<
    | { status: "indexed"; revisionId: string; chunkCount: number; rebuiltOnly: boolean }
    | { status: "retryable_failed"; message: string }
  > {
    try {
      const result = await this.runtime.ingestion.ingest(session, input);
      return {
        status: "indexed",
        revisionId: result.revisionId,
        chunkCount: result.chunks.length,
        rebuiltOnly: result.rebuiltOnly,
      };
    } catch (error) {
      return {
        status: "retryable_failed",
        message: error instanceof Error ? error.message : "automatic ingestion failed",
      };
    }
  }

  async ingestResource(
    token: string | undefined,
    resourceId: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    assertNoIdentityOverride(payload);
    const session = await this.authenticate(token);
    return this.runtime.ingestion.ingest(session, {
      resourceId,
      clientMutationId: stringValue(payload, "clientMutationId"),
      ...(typeof payload.revisionId === "string"
        ? { revisionId: payload.revisionId }
        : {}),
      ...(typeof payload.branchRef === "string"
        ? { branchRef: payload.branchRef }
        : {}),
      ...(typeof payload.maxChunkCharacters === "number"
        ? { maxChunkCharacters: payload.maxChunkCharacters }
        : {}),
    });
  }

  async readResource(
    token: string | undefined,
    resourceId: string,
    revisionId?: string,
  ): Promise<unknown> {
    const session = await this.authenticate(token);
    const result = await this.runtime.resources.read(session, {
      resourceId,
      ...(revisionId === undefined ? {} : { revisionId }),
    });
    const content = Buffer.from(result.content).toString("base64");
    return {
      resource: result.resource,
      revisionId: result.revisionId,
      contentBase64: content,
    };
  }

  async memoryCatalog(
    token: string | undefined,
    payload: Record<string, unknown> = {},
  ): Promise<{
    rootName: string;
    branchRef: string;
    entities: Array<{
      name: string;
      summary: string;
      status: string;
      tags: string[];
    }>;
    tags: Array<{
      tag: string;
      count: number;
      names: string[];
    }>;
  }> {
    assertNoIdentityOverride(payload);
    assertOnlyFields(payload, stableCatalogFields, "memory.catalog");
    const session = await this.authenticate(token);
    const branch = "main";
    const decision = await this.runtime.policy.decide({
      subject: gatewaySubject(session),
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      branchRef: branch,
      action: "read",
      resourceKind: "memory_entity",
    });
    if (!decision.allowed) {
      throw new TeamMemoryGatewayError(
        "permission_denied",
        decision.reason,
        decision as PermissionDecision & { allowed: false },
      );
    }

    const view = this.runtime.history.readActiveView(session.rootEntityId, branch);
    const branchById = new Map(view.entityBranches.map((candidate) => [
      candidate.id,
      candidate,
    ]));
    const rootEntity = view.entities.find(
      (entity) => entity.id === session.rootEntityId && entity.rootEntityId === null,
    );
    const rootBranch = rootEntity?.currentBranchId === undefined
      ? undefined
      : branchById.get(rootEntity.currentBranchId);
    const visibleEntities = view.entities
      .filter((entity) => entity.rootEntityId !== null)
      .filter((entity) =>
        session.taskScope.allowedEntityIds === undefined ||
        session.taskScope.allowedEntityIds.includes(entity.id)
      )
      .filter((entity) =>
        session.taskScope.deniedEntityIds?.includes(entity.id) !== true
      )
      .map((entity) => ({
        entity,
        branch: entity.currentBranchId === undefined
          ? undefined
          : branchById.get(entity.currentBranchId),
      }))
      .filter(({ entity, branch }) => {
        const tags = entityVisibleTags(entity, branch);
        return (
          (session.taskScope.allowedTags === undefined ||
            tags.some((tag) => session.taskScope.allowedTags?.includes(tag))) &&
          !tags.some((tag) => session.taskScope.deniedTags?.includes(tag))
        );
      });
    const tagMap = new Map<string, Set<string>>();
    for (const { entity, branch } of visibleEntities) {
      const name = entityVisibleName(entity, branch);
      for (const tag of entityVisibleTags(entity, branch)) {
        const names = tagMap.get(tag) ?? new Set<string>();
        names.add(name);
        tagMap.set(tag, names);
      }
    }
    return {
      rootName: entityVisibleName(rootEntity ?? {
        id: session.rootEntityId,
        rootEntityId: null,
        status: "active",
        createdAt: "",
        updatedAt: "",
      }, rootBranch),
      branchRef: branch,
      entities: visibleEntities.map(({ entity, branch }) => ({
        name: entityVisibleName(entity, branch),
        summary: entityVisibleSummary(entity, branch),
        status: entity.status,
        tags: entityVisibleTags(entity, branch),
      })),
      tags: [...tagMap.entries()]
        .map(([tag, names]) => ({
          tag,
          count: names.size,
          names: [...names].sort(),
        }))
        .sort((left, right) => left.tag.localeCompare(right.tag)),
    };
  }

  async writeMemory(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<StableWriteResult> {
    assertNoIdentityOverride(payload);
    assertOnlyFields(payload, stableWriteFields, "memory.write");
    const session = await this.authenticate(token);
    const branch = "main";
    const operations = this.canonicalOperations(payload);
    const resourceOperations = operations.filter((operation) => operation.target === "resource");
    if (resourceOperations.length > 0) {
      if (operations.length !== 1) {
        throw new TeamMemoryGatewayError(
          "validation_failed",
          "resource operations must be the only operation in memory.write",
        );
      }
      return this.writeResourceOperation(
        session,
        resourceOperations[0] as ResourceWriteOperation,
        branch,
      );
    }
    const prepared = await this.prepareStructuredMemoryOperations(
      session,
      { operations },
      branch,
    );
    if (prepared.status !== "ready") {
      return prepared;
    }
    const request: CloudMemoryWriteCommand = {
      subject: gatewaySubject(session),
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      branchRef: branch,
      action: "commit",
      resourceKind: "memory_entity",
      clientMutationId: `memory-write:${randomUUID()}`,
      ...(() => {
        const head = this.runtime.history.headCommitId(
          session.rootEntityId,
          branch,
        );
        return head === undefined ? {} : { expectedHeadCommitId: head };
      })(),
      commit: {
        id: prepared.commitId,
        message: `Capture memory update`,
      },
      operation: prepared.operations[0] as MemoryOperationInput,
      operations: prepared.operations,
    };
    const result = unwrap(await this.writeRouter.execute(request));
    if (result.status === "conflict") {
      throw new TeamMemoryGatewayError(
        "conflict",
        result.conflict.id,
      );
    }
    await this.projectMemoryIfEnabled(session.rootEntityId, branch);
    return {
      status: "captured",
      ...(prepared.entityId === undefined ? {} : { entityId: prepared.entityId }),
      ...(prepared.branchId === undefined ? {} : { branchId: prepared.branchId }),
      ...(prepared.relationId === undefined ? {} : { relationId: prepared.relationId }),
      commitIds: [result.write.commit.id],
      extra: prepared.extra,
    };
  }

  private canonicalOperations(
    payload: Record<string, unknown>,
  ): CanonicalMemoryOperation[] {
    const value = payload.operations;
    if (!Array.isArray(value) || value.length === 0) {
      throw new TeamMemoryGatewayError(
        "validation_failed",
        "operations must be a non-empty array",
      );
    }
    return value.map((operation, index) => {
      if (
        operation === null ||
        typeof operation !== "object" ||
        Array.isArray(operation)
      ) {
        throw new TeamMemoryGatewayError(
          "validation_failed",
          `operations[${index}] must be an object`,
        );
      }
      const candidate = operation as Record<string, unknown>;
      assertNoSystemManagedInput(candidate, `operations[${index}]`);
      assertOnlyFields(
        candidate,
        new Set(["target", "op", "name", "type", "subject", "object", "properties"]),
        `operations[${index}]`,
      );
      const target = candidate.target;
      const op = candidate.op;
      if (
        target !== "memory_entity" &&
        target !== "memory_entity_branch" &&
        target !== "memory_relation" &&
        target !== "resource"
      ) {
        throw new TeamMemoryGatewayError(
          "validation_failed",
          `operations[${index}].target is required`,
        );
      }
      if (typeof op !== "string") {
        throw new TeamMemoryGatewayError(
          "validation_failed",
          `operations[${index}].op is required`,
        );
      }
      if (candidate.properties !== undefined) {
        if (
          candidate.properties === null ||
          typeof candidate.properties !== "object" ||
          Array.isArray(candidate.properties)
        ) {
          throw new TeamMemoryGatewayError(
            "validation_failed",
            `operations[${index}].properties must be an object`,
          );
        }
        assertNoSystemManagedInput(
          candidate.properties as Record<string, unknown>,
          `operations[${index}].properties`,
        );
      }
      return candidate as unknown as CanonicalMemoryOperation;
    });
  }

  private structuredOperations(
    payload: Record<string, unknown>,
  ): StructuredMemoryOperation[] {
    return this.canonicalOperations(payload).map((operation, index) =>
      this.structuredOperationFromCanonical(operation, `operations[${index}]`)
    );
  }

  private structuredOperationFromCanonical(
    operation: CanonicalMemoryOperation,
    surface: string,
  ): StructuredMemoryOperation {
    if (operation.target === "resource") {
      throw new TeamMemoryGatewayError(
        "validation_failed",
        `${surface}.target resource must be the only operation in memory.write`,
      );
    }
    const properties = operation.properties ?? {};
    const description =
      typeof properties.description === "string"
        ? properties.description
        : typeof properties.desc === "string"
          ? properties.desc
          : undefined;
    if (operation.target === "memory_entity") {
      assertOnlyFields(
        properties,
        new Set(["name", "title", "desc", "description", "tags", "status"]),
        `${surface}.properties`,
      );
      if (
        operation.op !== "create" &&
        operation.op !== "update" &&
        operation.op !== "refresh"
      ) {
        throw new TeamMemoryGatewayError(
          "validation_failed",
          `${surface}.op is not supported for memory_entity`,
        );
      }
      const name = this.operationName(operation, properties, surface);
      const tags = properties.tags === undefined ? undefined : optionalTags(properties.tags);
      const base = {
        name,
        title: typeof properties.title === "string" ? properties.title : name,
        ...(description === undefined ? {} : { description }),
        ...(tags === undefined ? {} : { tags }),
        ...(typeof properties.status === "string" ? { status: properties.status } : {}),
      };
      if (operation.op === "create") return { op: "upsert_memory_entity", ...base };
      if (operation.op === "refresh") return { op: "refresh_memory_entity_summary", ...base };
      return { op: "update_memory_entity", ...base };
    }
    if (operation.target === "memory_entity_branch") {
      assertOnlyFields(
        properties,
        new Set(["name", "title", "desc", "description", "tags", "status", "extra", "extraInfo"]),
        `${surface}.properties`,
      );
      if (operation.op !== "create" && operation.op !== "update_metadata") {
        throw new TeamMemoryGatewayError(
          "validation_failed",
          `${surface}.op is not supported for memory_entity_branch`,
        );
      }
      const entityName = this.parentEntityName(operation.subject, surface);
      const name = this.operationName(operation, properties, surface);
      const extraInfo = this.extraInfo(properties, surface);
      const tags = properties.tags === undefined ? undefined : optionalTags(properties.tags);
      const branch = {
        entityName,
        name,
        title: typeof properties.title === "string" ? properties.title : name,
        ...(tags === undefined ? {} : { tags }),
        ...(typeof properties.status === "string" ? { status: properties.status } : {}),
        ...(extraInfo === undefined ? {} : { extraInfo }),
      };
      if (operation.op === "create") {
        if (description === undefined || description.length === 0) {
          throw new TeamMemoryGatewayError(
            "validation_failed",
            `${surface}.properties.description is required`,
          );
        }
        return { op: "create_memory_entity_branch", ...branch, description };
      }
      return { op: "update_memory_entity_branch_metadata", ...branch };
    }
    if (operation.target === "memory_relation") {
      if (operation.properties !== undefined && Object.keys(operation.properties).length > 0) {
        throw new TeamMemoryGatewayError(
          "validation_failed",
          `${surface}.properties is not supported for memory_relation`,
        );
      }
      if (operation.op !== "create" && operation.op !== "replace") {
        throw new TeamMemoryGatewayError(
          "validation_failed",
          `${surface}.op is not supported for memory_relation`,
        );
      }
      const relationType = optionalRelationType(operation.type);
      if (relationType === undefined) {
        throw new TeamMemoryGatewayError(
          "validation_failed",
          `${surface}.type is required`,
        );
      }
      return {
        op: operation.op === "replace" ? "replace_memory_relation" : "create_memory_relation",
        relationType,
        source: this.structuredEndpoint(operation.subject, `${surface}.subject`),
        target: this.structuredEndpoint(operation.object, `${surface}.object`),
      };
    }
    throw new TeamMemoryGatewayError(
      "validation_failed",
      `${surface}.target is not supported`,
    );
  }

  private operationName(
    operation: CanonicalMemoryOperation,
    properties: Record<string, unknown>,
    surface: string,
  ): string {
    const name = typeof properties.name === "string" ? properties.name : operation.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new TeamMemoryGatewayError(
        "validation_failed",
        `${surface}.properties.name is required`,
      );
    }
    return name;
  }

  private parentEntityName(
    value: CanonicalMemoryOperation["subject"],
    surface: string,
  ): string {
    if (typeof value === "string" && value.length > 0) return value;
    const endpoint = this.canonicalEndpoint(value, `${surface}.subject`);
    if (endpoint.target !== "memory_entity") {
      throw new TeamMemoryGatewayError(
        "validation_failed",
        `${surface}.subject must identify a memory_entity parent`,
      );
    }
    return endpoint.name;
  }

  private structuredEndpoint(
    value: CanonicalMemoryOperation["subject"],
    surface: string,
  ): StructuredEndpoint {
    const endpoint = this.canonicalEndpoint(value, surface);
    if (endpoint.target === "memory_entity_branch") {
      if (endpoint.parent === undefined) {
        throw new TeamMemoryGatewayError(
          "validation_failed",
          `${surface}.parent is required for memory_entity_branch`,
        );
      }
      return {
        kind: "memory_entity_branch",
        entityName: endpoint.parent,
        name: endpoint.name,
      };
    }
    return {
      kind: endpoint.target,
      name: endpoint.name,
    };
  }

  private canonicalEndpoint(
    value: CanonicalMemoryOperation["subject"],
    surface: string,
  ): CanonicalMemoryEndpoint {
    if (typeof value === "string" && value.length > 0) {
      return { target: "memory_entity", name: value };
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TeamMemoryGatewayError(
        "validation_failed",
        `${surface} is required`,
      );
    }
    const endpoint = value as unknown as Record<string, unknown>;
    assertNoSystemManagedInput(endpoint, surface);
    assertOnlyFields(endpoint, new Set(["target", "name", "parent"]), surface);
    if (
      endpoint.target !== "memory_entity" &&
      endpoint.target !== "memory_entity_branch" &&
      endpoint.target !== "resource" &&
      endpoint.target !== "resource_chunk"
    ) {
      throw new TeamMemoryGatewayError(
        "validation_failed",
        `${surface}.target is required`,
      );
    }
    return {
      target: endpoint.target,
      name: stringValue(endpoint, "name"),
      ...(typeof endpoint.parent === "string" ? { parent: endpoint.parent } : {}),
    };
  }

  private extraInfo(
    properties: Record<string, unknown>,
    surface: string,
  ): Record<string, unknown> | undefined {
    const extra = properties.extraInfo ?? properties.extra;
    if (extra === undefined) return undefined;
    if (extra === null || typeof extra !== "object" || Array.isArray(extra)) {
      throw new TeamMemoryGatewayError(
        "validation_failed",
        `${surface}.properties.extra must be an object`,
      );
    }
    assertNoSystemManagedInput(extra as Record<string, unknown>, `${surface}.properties.extra`);
    return extra as Record<string, unknown>;
  }

  private async prepareStructuredMemoryOperations(
    session: AuthenticatedSession,
    payload: Record<string, unknown>,
    branch: string,
  ): Promise<PlannedMemoryWrite | StableWriteResult> {
    const requested = this.structuredOperations(payload);
    const view = this.runtime.history.readActiveView(session.rootEntityId, branch);
    const now = new Date().toISOString();
    const commitId = `commit:memory-write:${randomUUID()}`;
    const operations: MemoryOperationInput[] = [];
    const entities = new Map(view.entities.map((entity) => [entity.id, structuredClone(entity)]));
    const branches = new Map(view.entityBranches.map((item) => [item.id, structuredClone(item)]));
    const relations = new Map(view.relations.map((relation) => [relation.id, structuredClone(relation)]));
    const resources = new Map(view.resources.map((resource) => [resource.id, structuredClone(resource)]));
    const chunks = new Map(view.resourceChunks.map((chunk) => [chunk.id, structuredClone(chunk)]));
    let lastEntityId: string | undefined;
    let lastBranchId: string | undefined;
    let lastRelationId: string | undefined;
    const applied: string[] = [];
    const systemCompletedOperations: string[] = [];
    const relatedMemoryCandidates: RelatedMemoryCandidate[] = [];

    const branchById = () => new Map([...branches.values()].map((item) => [item.id, item]));
    const exactEntitiesByName = (name: string): MemoryEntity[] => {
      const currentBranches = branchById();
      return [...entities.values()]
        .filter((entity) => entity.rootEntityId !== null)
        .filter((entity) => entityVisibleName(entity, currentBranches.get(entity.currentBranchId ?? "")) === name);
    };
    const exactEntity = (name: string): MemoryEntity | StableWriteResult => {
      const matches = exactEntitiesByName(name);
      if (matches.length !== 1) {
        return this.ambiguousResult(
          { kind: "memory_entity", name },
          matches.map((entity) => entityVisibleName(entity, branchById().get(entity.currentBranchId ?? ""))),
        );
      }
      return matches[0] as MemoryEntity;
    };
    const ensureEntityForBranch = async (
      name: string,
      description: string,
      tags: string[] = [],
    ): Promise<MemoryEntity | StableWriteResult> => {
      const matches = exactEntitiesByName(name);
      if (matches.length > 1) {
        return this.ambiguousResult(
          { kind: "memory_entity", name },
          matches.map((entity) => entityVisibleName(entity, branchById().get(entity.currentBranchId ?? ""))),
        );
      }
      const existing = matches[0];
      if (existing !== undefined) return existing;
      const entityId = `entity:${randomUUID()}`;
      const entity: MemoryEntity = {
        id: entityId,
        rootEntityId: session.rootEntityId,
        name,
        title: name,
        description,
        tags,
        embedding: await this.runtime.embeddings.embed([name, description, ...tags].join("\n")),
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      entities.set(entityId, entity);
      operations.push({
        kind: "create_entity",
        id: `operation:${commitId}:${operations.length}`,
        entity,
      });
      applied.push("memory_entity/create");
      return entity;
    };
    const exactBranch = (entityName: string, name: string): MemoryEntityBranch | StableWriteResult => {
      const entity = exactEntity(entityName);
      if (isStableWriteResult(entity)) return entity;
      const matches = [...branches.values()].filter((candidate) =>
        candidate.entityId === entity.id && candidate.title === name
      );
      if (matches.length !== 1) {
        return this.ambiguousResult(
          { kind: "memory_entity_branch", name },
          matches.map(({ title }) => title),
        );
      }
      return matches[0] as MemoryEntityBranch;
    };
    const ensureHasRelation = (
      entity: MemoryEntity,
      memoryBranch: MemoryEntityBranch,
      parentName: string,
    ): void => {
      const existing = [...relations.values()].find((candidate) =>
        candidate.sourceKind === "memory_entity" &&
        candidate.sourceId === entity.id &&
        candidate.targetKind === "memory_entity_branch" &&
        candidate.targetId === memoryBranch.id &&
        candidate.relationType === "has" &&
        candidate.status === "active"
      );
      if (existing !== undefined) return;
      const relation: MemoryRelation = {
        id: `relation:${randomUUID()}`,
        rootEntityId: session.rootEntityId,
        sourceKind: "memory_entity",
        sourceId: entity.id,
        targetKind: "memory_entity_branch",
        targetId: memoryBranch.id,
        relationType: "has",
        weight: 1,
        confidence: 0.9,
        branchRef: branch,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      relations.set(relation.id, relation);
      operations.push({
        kind: "create_relation",
        id: `operation:${commitId}:${operations.length}`,
        relation,
      });
      systemCompletedOperations.push(
        `memory_relation/create:has:${parentName}->${memoryBranch.title}`,
      );
    };
    const relatedBranchCandidates = (
      entityName: string,
      newBranchTitle: string,
      scoredBranches: Array<{ branch: MemoryEntityBranch; score: number }>,
    ): RelatedMemoryCandidate[] =>
      scoredBranches
        .filter(({ score }) =>
          score >= this.branchRelationHintThreshold &&
          score < this.branchDedupeThreshold
        )
        .slice(0, 3)
        .map(({ branch: candidate, score }) => ({
          kind: "memory_entity_branch",
          parent: entityName,
          name: candidate.title,
          desc: candidate.description,
          tags: candidate.tags,
          similarity: Number(score.toFixed(6)),
          ...(candidate.extraInfo === undefined ? {} : { extra: candidate.extraInfo }),
          recommendation: {
            action: "create_memory_relation",
            reason: "similarity_below_dedupe_threshold",
            suggestedTypes: ["relates_to", "supersedes", "contradicts"],
            subject: {
              target: "memory_entity_branch",
              name: newBranchTitle,
              parent: entityName,
            },
            object: {
              target: "memory_entity_branch",
              name: candidate.title,
              parent: entityName,
            },
          },
        }));
    const endpointId = (endpoint: StructuredEndpoint): string | StableWriteResult => {
      assertNoSystemManagedInput(endpoint as unknown as Record<string, unknown>, "operation endpoint");
      if (
        endpoint.kind !== "memory_entity" &&
        endpoint.kind !== "memory_entity_branch" &&
        endpoint.kind !== "resource" &&
        endpoint.kind !== "resource_chunk"
      ) {
        throw new TeamMemoryGatewayError(
          "validation_failed",
          "relation endpoints must be memory_entity, memory_entity_branch, resource, or resource_chunk",
        );
      }
      if (endpoint.kind === "memory_entity") {
        if (typeof endpoint.name !== "string") {
          throw new TeamMemoryGatewayError("validation_failed", "memory_entity endpoint requires name");
        }
        const entity = exactEntity(endpoint.name);
        return isStableWriteResult(entity) ? entity : entity.id;
      }
      if (endpoint.kind === "memory_entity_branch") {
        if (typeof endpoint.entityName !== "string" || typeof endpoint.name !== "string") {
          throw new TeamMemoryGatewayError("validation_failed", "memory_entity_branch endpoint requires entityName and name");
        }
        const found = exactBranch(endpoint.entityName, endpoint.name);
        return isStableWriteResult(found) ? found : found.id;
      }
      const collection = endpoint.kind === "resource" ? resources : chunks;
      if (typeof endpoint.name !== "string") {
        throw new TeamMemoryGatewayError("validation_failed", `${endpoint.kind} endpoint requires name`);
      }
      const matches = [...collection.values()].filter((candidate) =>
        "title" in candidate ? candidate.title === endpoint.name : candidate.id === endpoint.name
      );
      if (matches.length !== 1) {
        return this.ambiguousResult(
          { kind: endpoint.kind, name: endpoint.name },
          matches.map((candidate) => "title" in candidate ? candidate.title : candidate.id),
        );
      }
      return matches[0]?.id as string;
    };

    for (const [index, operation] of requested.entries()) {
      const surface = `operations[${index}]`;
      assertNoSystemManagedInput(operation as unknown as Record<string, unknown>, surface);
      if (
        operation.op === "upsert_memory_entity" ||
        operation.op === "update_memory_entity" ||
        operation.op === "refresh_memory_entity_summary"
      ) {
        const name = stringValue(operation as unknown as Record<string, unknown>, "name");
        const matches = exactEntitiesByName(name);
        if (operation.op !== "upsert_memory_entity" && matches.length !== 1) {
          return this.ambiguousResult({ kind: "memory_entity", name }, matches.map((entity) => entityVisibleName(entity, branchById().get(entity.currentBranchId ?? ""))));
        }
        if (matches.length > 1) {
          return this.ambiguousResult({ kind: "memory_entity", name }, matches.map((entity) => entityVisibleName(entity, branchById().get(entity.currentBranchId ?? ""))));
        }
        const existing = matches[0];
        const title = operation.title ?? name;
        const description = operation.description ?? existing?.description ?? "";
        const tags = operation.tags ?? existing?.tags ?? [];
        const status = optionalStatus(operation.status, ["active", "archived", "tombstoned", "conflicted"] as const) ?? existing?.status ?? "active";
        const entityId = existing?.id ?? `entity:${randomUUID()}`;
        const entity: MemoryEntity = {
          ...(existing ?? {
            id: entityId,
            rootEntityId: session.rootEntityId,
            createdAt: now,
            updatedAt: now,
          }),
          id: entityId,
          rootEntityId: session.rootEntityId,
          name: title,
          title,
          description,
          tags,
          embedding: await this.runtime.embeddings.embed([title, description, ...tags].join("\n")),
          status,
          updatedAt: now,
        };
        entities.set(entityId, entity);
        operations.push(existing === undefined
          ? { kind: "create_entity", id: `operation:${commitId}:${operations.length}`, entity }
          : { kind: "update_entity", id: `operation:${commitId}:${operations.length}`, targetId: entityId, entity });
        lastEntityId = entityId;
        applied.push(
          operation.op === "refresh_memory_entity_summary"
            ? "memory_entity/refresh"
            : operation.op === "update_memory_entity"
              ? "memory_entity/update"
              : "memory_entity/create",
        );
        continue;
      }

      if (operation.op === "create_memory_entity_branch") {
        const description = operation.description;
        if (typeof description !== "string" || description.length === 0) {
          throw new TeamMemoryGatewayError("validation_failed", `${surface}.description is required`);
        }
        const entity = await ensureEntityForBranch(
          operation.entityName,
          description,
          operation.tags ?? [],
        );
        if (isStableWriteResult(entity)) return entity;
        const title = operation.title ?? operation.name ?? operation.description.slice(0, 80);
        const embedding = await this.runtime.embeddings.embed(description);
        const entityBranches = [...branches.values()].filter((candidate) => candidate.entityId === entity.id);
        const exactTitleDuplicate = entityBranches.find((candidate) =>
          normalizedBranchTitle(candidate.title) === normalizedBranchTitle(title)
        );
        const scored = entityBranches
          .filter((candidate) => candidate.embedding !== undefined)
          .map((candidate) => ({
            branch: candidate,
            score: cosineSimilarity(embedding, candidate.embedding ?? []),
          }))
          .sort((left, right) => right.score - left.score);
        const duplicate = exactTitleDuplicate === undefined
          ? scored[0]
          : { branch: exactTitleDuplicate, score: 1 };
        if (duplicate !== undefined && duplicate.score >= this.branchDedupeThreshold) {
          const existing = duplicate.branch;
          const next: MemoryEntityBranch = {
            ...existing,
            importance: operation.importance ?? Math.max(existing.importance, 0.75),
            confidence: operation.confidence ?? existing.confidence,
            extraInfo: {
              ...(existing.extraInfo ?? {}),
              lastSeenAt: now,
              duplicateMentions: Number(existing.extraInfo?.duplicateMentions ?? 0) + 1,
              dedupeSimilarity: duplicate.score,
            },
            updatedAt: now,
          };
          branches.set(existing.id, next);
          operations.push({
            kind: "update_entity_branch_metadata",
            id: `operation:${commitId}:${operations.length}`,
            targetId: existing.id,
            branch: next,
          });
          lastEntityId = entity.id;
          lastBranchId = existing.id;
          ensureHasRelation(entity, next, operation.entityName);
          applied.push("memory_entity_branch/update_metadata");
          continue;
        }
        relatedMemoryCandidates.push(
          ...relatedBranchCandidates(operation.entityName, title, scored),
        );
        const branchId = `branch:${randomUUID()}`;
        const memoryBranch: MemoryEntityBranch = {
          id: branchId,
          entityId: entity.id,
          rootEntityId: session.rootEntityId,
          branchRef: branch,
          title,
          description,
          tags: operation.tags ?? [],
          ...(operation.extraInfo === undefined ? {} : { extraInfo: operation.extraInfo }),
          embedding,
          importance: operation.importance ?? 0.75,
          confidence: operation.confidence ?? 0.8,
          status: optionalStatus(operation.status, ["active", "pending", "conflicted", "deprecated", "verified", "superseded", "tombstoned"] as const) ?? "active",
          createdAt: now,
          updatedAt: now,
        };
        branches.set(branchId, memoryBranch);
        operations.push({
          kind: "create_entity_branch",
          id: `operation:${commitId}:${operations.length}`,
          branch: memoryBranch,
        });
        ensureHasRelation(entity, memoryBranch, operation.entityName);
        lastEntityId = entity.id;
        lastBranchId = branchId;
        applied.push("memory_entity_branch/create");
        continue;
      }

      if (operation.op === "update_memory_entity_branch_metadata") {
        const existing = exactBranch(operation.entityName, operation.name);
        if (isStableWriteResult(existing)) return existing;
        const next: MemoryEntityBranch = {
          ...existing,
          tags: operation.tags ?? existing.tags,
          ...(operation.extraInfo === undefined ? {} : { extraInfo: { ...(existing.extraInfo ?? {}), ...operation.extraInfo } }),
          importance: operation.importance ?? existing.importance,
          confidence: operation.confidence ?? existing.confidence,
          status: optionalStatus(operation.status, ["active", "pending", "conflicted", "deprecated", "verified", "superseded", "tombstoned"] as const) ?? existing.status,
          updatedAt: now,
        };
        branches.set(existing.id, next);
        operations.push({ kind: "update_entity_branch_metadata", id: `operation:${commitId}:${operations.length}`, targetId: existing.id, branch: next });
        lastEntityId = existing.entityId;
        lastBranchId = existing.id;
        applied.push("memory_entity_branch/update_metadata");
        continue;
      }

      if (
        operation.op === "create_memory_relation" ||
        operation.op === "replace_memory_relation" ||
        operation.op === "link_evidence"
      ) {
        const source = operation.op === "link_evidence" ? operation.source : operation.source;
        const target = operation.op === "link_evidence" ? operation.target : operation.target;
        const sourceId = endpointId(source);
        if (typeof sourceId !== "string") return sourceId;
        const targetId = endpointId(target);
        if (typeof targetId !== "string") return targetId;
        const relationType = operation.op === "link_evidence"
          ? "refers_to"
          : optionalRelationType(operation.relationType);
        if (relationType === undefined) {
          throw new TeamMemoryGatewayError(
            "validation_failed",
            `${surface}.relationType is required`,
          );
        }
        const relationId = `relation:${randomUUID()}`;
        const relation: MemoryRelation = {
          id: relationId,
          rootEntityId: session.rootEntityId,
          sourceKind: source.kind,
          sourceId,
          targetKind: target.kind,
          targetId,
          relationType,
          ...(operation.description === undefined ? {} : { role: operation.description }),
          ...(operation.op !== "link_evidence" && operation.role !== undefined ? { role: operation.role } : {}),
          ...(operation.op !== "link_evidence" && operation.ordinal !== undefined ? { ordinal: operation.ordinal } : {}),
          ...(operation.op !== "link_evidence" && operation.required !== undefined ? { required: operation.required } : {}),
          weight: operation.op !== "link_evidence" ? operation.weight ?? 1 : 1,
          confidence: operation.op !== "link_evidence" ? operation.confidence ?? 0.8 : 0.9,
          branchRef: branch,
          status: "active",
          createdAt: now,
          updatedAt: now,
        };
        if (operation.op === "replace_memory_relation") {
          const previous = [...relations.values()].find((candidate) =>
            candidate.sourceId === sourceId &&
            candidate.targetId === targetId &&
            candidate.relationType === relation.relationType &&
            candidate.status === "active"
          );
          if (previous === undefined) {
            return this.ambiguousResult({ kind: "memory_relation", name: relation.relationType }, []);
          }
          operations.push({
            kind: "replace_relation",
            id: `operation:${commitId}:${operations.length}`,
            previousRelationId: previous.id,
            replacementOperationId: `operation:${commitId}:${operations.length}:create`,
            replacement: relation,
          });
        } else {
          operations.push({ kind: "create_relation", id: `operation:${commitId}:${operations.length}`, relation });
        }
        relations.set(relationId, relation);
        lastRelationId = relationId;
        applied.push(
          operation.op === "replace_memory_relation"
            ? "memory_relation/replace"
            : "memory_relation/create",
        );
        continue;
      }

      throw new TeamMemoryGatewayError(
        "validation_failed",
        `${surface}.op is not supported`,
      );
    }

    const extra: Record<string, unknown> = { operationsApplied: applied };
    if (systemCompletedOperations.length > 0) {
      extra.systemCompletedOperations = systemCompletedOperations;
    }
    if (relatedMemoryCandidates.length > 0) {
      extra.relatedMemoryCandidates = relatedMemoryCandidates;
    }

    return {
      status: "ready",
      commitId,
      operations,
      ...(lastEntityId === undefined ? {} : { entityId: lastEntityId }),
      ...(lastBranchId === undefined ? {} : { branchId: lastBranchId }),
      ...(lastRelationId === undefined ? {} : { relationId: lastRelationId }),
      extra,
    };
  }

  private async prepareStableMemoryOperations(
    session: AuthenticatedSession,
    target: StableTarget,
    patch: Record<string, unknown>,
    _payload: Record<string, unknown>,
    branch: string,
  ): Promise<PlannedMemoryWrite | StableWriteResult> {
    const view = this.runtime.history.readActiveView(session.rootEntityId, branch);
    const branchById = new Map(view.entityBranches.map((candidate) => [
      candidate.id,
      candidate,
    ]));
    const now = new Date().toISOString();
    const commitId = `commit:memory-write:${randomUUID()}`;
    if (target.kind === "memory_entity") {
      const matches = view.entities
        .filter((entity) => entity.rootEntityId !== null)
        .filter((entity) => entityVisibleName(
          entity,
          branchById.get(entity.currentBranchId ?? ""),
        ) === target.name);
      if (matches.length > 1) {
        return this.ambiguousResult(target, matches.map((entity) =>
          entityVisibleName(entity, branchById.get(entity.currentBranchId ?? ""))
        ));
      }
      const title = typeof patch.title === "string"
        ? patch.title
        : typeof patch.name === "string"
          ? patch.name
          : target.name;
      const existing = matches[0];
      const tags = optionalTags(patch.tags) ?? existing?.tags ?? [];
      const status = optionalStatus(patch.status, [
        "active",
        "archived",
        "tombstoned",
        "conflicted",
      ] as const) ?? existing?.status ?? "active";
      if (
        existing !== undefined &&
        (patch.description === undefined || existing.description === patch.description) &&
        (patch.title === undefined || existing.title === patch.title) &&
        (patch.name === undefined || existing.name === patch.name) &&
        (patch.tags === undefined ||
          JSON.stringify(existing.tags ?? []) === JSON.stringify(tags)) &&
        (patch.status === undefined || existing.status === patch.status)
      ) {
        return {
          status: "duplicate",
          ...(existing === undefined ? {} : { entityId: existing.id }),
          commitIds: [],
          extra: { captureDecision: "duplicate_signal" },
        };
      }
      const entityId = existing?.id ?? `entity:${randomUUID()}`;
      const description = descriptionFromPatch(patch) || existing?.description || "";
      const embedding = await this.runtime.embeddings.embed(
        [title, description, ...tags].join("\n"),
      );
      const entity: MemoryEntity = {
        ...(existing ?? {
          id: entityId,
          rootEntityId: session.rootEntityId,
          status,
          createdAt: now,
          updatedAt: now,
        }),
        id: entityId,
        rootEntityId: session.rootEntityId,
        name: title,
        title,
        description,
        tags,
        embedding,
        status,
        updatedAt: now,
      };
      const operations: MemoryOperationInput[] = [];
      if (existing === undefined) {
        operations.push({
          kind: "create_entity",
          id: `operation:${commitId}:entity`,
          entity,
        });
      } else {
        operations.push({
          kind: "update_entity",
          id: `operation:${commitId}:entity`,
          targetId: entityId,
          entity,
        });
      }
      return {
        status: "ready",
        commitId,
        operations,
        entityId,
        extra: {
          captureDecision: existing === undefined ? "new_entity" : "update_entity",
        },
      };
    }

    if (target.kind === "memory_entity_branch") {
      const matches = view.entityBranches.filter((candidate) =>
        candidate.title === target.name
      );
      if (matches.length !== 1) {
        return this.ambiguousResult(target, matches.map(({ title }) => title));
      }
      const existing = matches[0] as MemoryEntityBranch;
      if (existing.description === descriptionFromPatch(patch)) {
        return {
          status: "duplicate",
          entityId: existing.entityId,
          branchId: existing.id,
          commitIds: [],
          extra: { captureDecision: "duplicate_signal" },
        };
      }
      const branchId = `branch:${randomUUID()}`;
      const tags = optionalTags(patch.tags) ?? existing.tags;
      const nextBranch: MemoryEntityBranch = {
        ...existing,
        id: branchId,
        parentBranchId: existing.id,
        title: typeof patch.title === "string"
          ? patch.title
          : typeof patch.name === "string" ? patch.name : existing.title,
        description: typeof patch.description === "string"
          ? patch.description
          : existing.description,
        tags,
        ...(patch.extraInfo === undefined
          ? {}
          : { extraInfo: patch.extraInfo as Record<string, unknown> }),
        status: optionalStatus(patch.status, [
          "active",
          "pending",
          "conflicted",
          "deprecated",
          "verified",
          "superseded",
          "tombstoned",
        ] as const) ?? existing.status,
        createdAt: now,
        updatedAt: now,
      };
      const relationId = `relation:${randomUUID()}`;
      return {
        status: "ready",
        commitId,
        entityId: existing.entityId,
        branchId,
        relationId,
        operations: [
          {
            kind: "create_entity_branch",
            id: `operation:${commitId}:branch`,
            branch: nextBranch,
          },
          {
            kind: "create_relation",
            id: `operation:${commitId}:relation`,
            relation: {
              id: relationId,
              rootEntityId: session.rootEntityId,
              sourceKind: "memory_entity_branch",
              sourceId: branchId,
              targetKind: "memory_entity_branch",
              targetId: existing.id,
              relationType: "relates_to",
              branchRef: branch,
              weight: 1,
              confidence: 0.75,
              status: "active",
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
        extra: {
          captureDecision: "new_branch",
          relationType: "relates_to",
        },
      };
    }

    const relationMatches = view.relations.filter((candidate) =>
      candidate.relationType === target.name ||
      candidate.id === target.name
    );
    if (relationMatches.length !== 1) {
      return this.ambiguousResult(
        target,
        relationMatches.map(({ relationType }) => relationType),
      );
    }
    const relation = relationMatches[0] as MemoryRelation;
    const replacement: MemoryRelation = {
      ...relation,
      id: `relation:${randomUUID()}`,
      sourceId: typeof patch.sourceId === "string" ? patch.sourceId : relation.sourceId,
      targetId: typeof patch.targetId === "string" ? patch.targetId : relation.targetId,
      relationType: optionalRelationType(patch.relationType) ?? relation.relationType,
      status: optionalStatus(patch.status, [
        "active",
        "tombstoned",
        "conflicted",
      ] as const) ?? relation.status,
      updatedAt: now,
    };
    return {
      status: "ready",
      commitId,
      relationId: replacement.id,
      operations: [
        {
          kind: "replace_relation",
          id: `operation:${commitId}:tombstone-relation`,
          previousRelationId: relation.id,
          replacementOperationId: `operation:${commitId}:create-relation`,
          replacement,
        },
      ],
      extra: { captureDecision: "replace_relation" },
    };
  }

  private ambiguousResult(
    target: AmbiguousTarget,
    candidates: string[],
  ): StableWriteResult {
    return {
      status: "ambiguous",
      commitIds: [],
      extra: {
        target,
        candidates,
        guidance: "search_or_catalog_first",
      },
    };
  }

  private async writeResourceOperation(
    session: AuthenticatedSession,
    operation: ResourceWriteOperation,
    branch: string,
  ): Promise<StableWriteResult> {
    if (operation.op !== "update" && operation.op !== "replace") {
      throw new TeamMemoryGatewayError(
        "validation_failed",
        "resource operations support update or replace",
      );
    }
    if (typeof operation.name !== "string" || operation.name.length === 0) {
      throw new TeamMemoryGatewayError(
        "validation_failed",
        "resource operations require name",
      );
    }
    const patch = operation.properties ?? {};
    assertNoSystemManagedInput(patch, "resource operation properties");
    assertOnlyFields(patch, resourcePatchFields, "resource operation properties");
    return this.writeResourcePatch(
      session,
      { kind: "resource", name: operation.name },
      patch,
      branch,
    );
  }

  private async writeResourcePatch(
    session: AuthenticatedSession,
    target: StableTarget,
    patch: Record<string, unknown>,
    branch: string,
  ): Promise<StableWriteResult> {
    const view = this.runtime.history.readActiveView(session.rootEntityId, branch);
    const matches = view.resources.filter((resource) => resource.title === target.name);
    if (matches.length !== 1) {
      return this.ambiguousResult(target, matches.map(({ title }) => title));
    }
    const resource = matches[0] as { id: string };
    let content: string | Uint8Array;
    if (typeof patch.contentBase64 === "string") {
      content = Buffer.from(patch.contentBase64, "base64");
    } else if (typeof patch.content === "string") {
      content = patch.content;
    } else {
      throw new TeamMemoryGatewayError(
        "validation_failed",
        "resource patch requires content or contentBase64",
      );
    }
    if (patch.lineRange !== undefined) {
      const lineRange = patch.lineRange as { start?: unknown; end?: unknown };
      if (
        typeof lineRange !== "object" ||
        lineRange === null ||
        typeof lineRange.start !== "number" ||
        typeof lineRange.end !== "number" ||
        lineRange.start < 1 ||
        lineRange.end < lineRange.start ||
        typeof content !== "string"
      ) {
        throw new TeamMemoryGatewayError(
          "validation_failed",
          "lineRange requires string content and numeric start/end",
        );
      }
      const current = await this.runtime.resources.read(session, {
        resourceId: resource.id,
        branchRef: branch,
      });
      const text = Buffer.from(current.content).toString();
      const lines = text.split(/\r?\n/);
      lines.splice(lineRange.start - 1, lineRange.end - lineRange.start + 1, content);
      content = lines.join("\n");
    }
    const clientMutationId = `memory-write-resource:${randomUUID()}`;
    const commitId = `commit:${clientMutationId}`;
    const revision = await this.runtime.resources.revise(session, {
      clientMutationId,
      commitId,
      resourceId: resource.id,
      content,
      branchRef: branch,
    });
    const ingestion = await this.tryAutomaticIngestion(session, {
      resourceId: resource.id,
      revisionId: revision.revisionId,
      branchRef: branch,
      clientMutationId: `${clientMutationId}:auto-ingest`,
    });
    return {
      status: "captured",
      resourceId: resource.id,
      revisionId: revision.revisionId,
      commitIds: [commitId],
      extra: { captureDecision: "resource_revision", ingestion },
    };
  }

  async searchMemory(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<PermissionRouteResult<MemoryRetrievalResult>> {
    assertNoIdentityOverride(payload);
    assertOnlyFields(payload, stableSearchFields, "memory.search");
    const session = await this.authenticate(token);
    const text = stringValue(payload, "query");
    const request: MemoryRetrievalRequest = {
      subject: gatewaySubject(session),
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      branchRef: "main",
      action: "search",
      resourceKind: "memory_entity",
      query: {
        kind: "recall",
        text,
        ...(numberValue(payload, "limit") === undefined
          ? {}
          : { limit: numberValue(payload, "limit") as number }),
        ...(optionalRecallLayer(payload) === undefined
          ? {}
          : { layer: optionalRecallLayer(payload) as "L1" | "L2" | "L3" }),
        ...(optionalStringList(payload, "names") === undefined
          ? {}
          : { names: optionalStringList(payload, "names") as string[] }),
        ...(optionalStringList(payload, "tagsAny") === undefined
          ? {}
          : { tagsAny: optionalStringList(payload, "tagsAny") as string[] }),
      },
    };
    return this.retrievalRouter.execute(request);
  }

  async recallHostMemory(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<InjectedMemoryContext> {
    assertNoIdentityOverride(payload);
    const input = hostRecallInput(payload);
    const session = await this.authenticate(token);
    const branch = input.branchRef ?? "main";
    let result = unwrap(await this.retrievalRouter.execute({
      subject: gatewaySubject(session),
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      branchRef: branch,
      action: "search",
      resourceKind: "memory_entity",
      query: {
        kind: "entity",
        text: recallSearchText(input),
        limit: input.limit ?? 8,
      },
    }));
    if (result.items.length === 0) {
      result = unwrap(await this.retrievalRouter.execute({
        subject: gatewaySubject(session),
        rootEntityId: session.rootEntityId,
        taskScope: session.taskScope,
        branchRef: branch,
        action: "search",
        resourceKind: "memory_entity",
        query: {
          kind: "entity",
          limit: input.limit ?? 8,
        },
      }));
    }
    return formatInjectedMemoryContext(input.host, result);
  }

  async captureHostMemory(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<MemoryCaptureResult> {
    assertNoIdentityOverride(payload);
    const input = hostCaptureInput(payload);
    const session = await this.authenticate(token);
    const branch = input.branchRef ?? "main";
    const id = randomUUID();
    const conversationText = captureConversationText(input);
    const provenance = {
      host: input.host,
      sessionId: input.sessionId,
      outcome: input.outcome,
      ...(input.userPrompt === undefined ? {} : { userPrompt: input.userPrompt }),
      ...(input.finalAssistantMessage === undefined
        ? {}
        : { finalAssistantMessage: input.finalAssistantMessage }),
      ...(input.transcriptPath === undefined ? {} : { transcriptPath: input.transcriptPath }),
      ...(input.errorSummary === undefined ? {} : { errorSummary: input.errorSummary }),
      ...(input.toolEvents === undefined ? {} : { toolEvents: input.toolEvents }),
    };
    const resourceId = `host-capture-resource:${id}`;
    const revisionId = `host-capture-revision:${id}`;
    const commitId = `host-capture-commit:${id}`;
    const imported = await this.runtime.resources.import(session, {
      clientMutationId: `host-capture:${id}`,
      resourceId,
      revisionId,
      commitId,
      branchRef: branch,
      title: input.title ?? captureTitle(input),
      sourceType: "conversation",
      content: conversationText,
      uri: `${input.host}:session:${input.sessionId}`,
      metadata: {
        ...provenance,
        layer: "L1",
        captureKind: "host_lifecycle",
      },
    });
    const lifecycleLog: Array<Record<string, unknown>> = [
      {
        event: "lifecycle.resource_imported",
        resourceId,
        revisionId,
      },
    ];
    let chunkIds: string[] = [];
    try {
      const ingestion = await this.runtime.ingestion.ingest(session, {
        resourceId,
        revisionId,
        branchRef: branch,
        clientMutationId: `host-capture-ingest:${id}`,
      });
      chunkIds = ingestion.chunks.map((chunk) => chunk.id);
      lifecycleLog.push({
        event: "lifecycle.resource_ingested",
        chunkIds,
        rebuiltOnly: ingestion.rebuiltOnly,
      });
    } catch (error) {
      lifecycleLog.push({
        event: "lifecycle.resource_ingest_failed",
        error: error instanceof Error ? error.message : "unknown ingestion error",
      });
    }
    const extractionCandidates = extractLifecycleStructuredOperations(
      input,
      chunkIds,
    );
    return {
      status: "captured",
      resourceId,
      revisionId,
      chunkIds,
      commitIds: [commitId],
      extractionCandidates,
      extra: {
        ...provenance,
        contentHash: imported.contentHash,
        captureLayers: [
          "L1:conversation_resource",
          "L1:resource_chunk",
          "candidate:structured_memory_operations",
        ],
        layerIds: {
          resourceId,
          revisionId,
          chunkIds,
        },
        lifecycleLog,
      },
    };
  }

  async listHistory(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<{
    records: ReturnType<TeamMemoryRuntime["history"]["listCommitRecords"]>;
  }> {
    assertNoIdentityOverride(payload);
    const session = await this.authenticate(token);
    const branch = branchRef(payload);
    const decision = await this.runtime.policy.decide({
      subject: gatewaySubject(session),
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      branchRef: branch,
      action: "read",
      resourceKind: "memory_entity",
    });
    if (!decision.allowed) {
      throw new TeamMemoryGatewayError(
        "permission_denied",
        decision.reason,
        decision as PermissionDecision & { allowed: false },
      );
    }
    return {
      records: this.runtime.history.listCommitRecords(
        session.rootEntityId,
        branch,
        numberValue(payload, "afterSequence") ?? 0,
      ),
    };
  }

  async listConflicts(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    assertNoIdentityOverride(payload);
    const session = await this.authenticate(token);
    const branch = branchRef(payload);
    const decision = await this.runtime.policy.decide({
      subject: gatewaySubject(session),
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      branchRef: branch,
      action: "read",
      resourceKind: "memory_entity",
    });
    if (!decision.allowed) {
      throw new TeamMemoryGatewayError(
        "permission_denied",
        decision.reason,
        decision as PermissionDecision & { allowed: false },
      );
    }
    return {
      conflicts: this.runtime.history.listConflicts(
        session.rootEntityId,
        branch,
      ),
    };
  }

  async resolveConflict(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<ConflictResolutionResult> {
    assertNoIdentityOverride(payload);
    const session = await this.authenticate(token);
    const branch = branchRef(payload);
    const request: ConflictResolutionCommand = {
      subject: gatewaySubject(session),
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      branchRef: branch,
      action: "merge",
      resourceKind: "memory_entity",
      clientMutationId: stringValue(payload, "clientMutationId"),
      commit: objectValue(payload, "commit") as ConflictResolutionCommand["commit"],
      conflictIds: (payload.conflictIds as string[] | undefined) ?? [],
      resolutionKind: stringValue(
        payload,
        "resolutionKind",
      ) as ConflictResolutionCommand["resolutionKind"],
    };
    if (payload.manualOperation !== undefined) {
      request.manualOperation =
        payload.manualOperation as NonNullable<
          ConflictResolutionCommand["manualOperation"]
        >;
      request.manualAction = payload.manualAction as MemoryAction;
      request.manualResourceKind = payload.manualResourceKind as MemoryObjectKind;
    }
    const result = unwrap(await this.resolutionRouter.execute(request));
    await this.projectMemoryIfEnabled(session.rootEntityId, branch);
    return result;
  }

  async pullSync(
    token: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<PermissionRouteResult<AuthorizedSyncBatch>> {
    assertNoIdentityOverride(payload);
    const session = await this.authenticate(token);
    return this.syncRouter.execute({
      subject: gatewaySubject(session),
      rootEntityId: session.rootEntityId,
      taskScope: session.taskScope,
      branchRef: branchRef(payload),
      action: "read",
      resourceKind: "memory_entity",
      ...(numberValue(payload, "knownCommitWatermark") === undefined
        ? {}
        : {
            knownCommitWatermark: numberValue(
              payload,
              "knownCommitWatermark",
            ) as number,
          }),
      ...(optionalString(payload, "knownPermissionWatermark") === undefined
        ? {}
        : {
            knownPermissionWatermark: optionalString(
              payload,
              "knownPermissionWatermark",
            ) as string,
          }),
      ...(optionalString(payload, "knownTaskScopeHash") === undefined
        ? {}
        : {
            knownTaskScopeHash: optionalString(
              payload,
              "knownTaskScopeHash",
            ) as string,
          }),
    });
  }
}

export function gatewayErrorFromUnknown(error: unknown): TeamMemoryGatewayError {
  if (error instanceof TeamMemoryGatewayError) return error;
  if (error instanceof ResourceNotFoundError) {
    return new TeamMemoryGatewayError("not_found", error.message);
  }
  if (error instanceof ResourceConflictError) {
    return new TeamMemoryGatewayError("conflict", error.conflictId);
  }
  if (error instanceof SyntaxError) {
    return new TeamMemoryGatewayError("validation_failed", error.message);
  }
  return new TeamMemoryGatewayError(
    "validation_failed",
    error instanceof Error ? error.message : "invalid request",
  );
}
