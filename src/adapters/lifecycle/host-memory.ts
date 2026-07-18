import type {
  MemoryRetrievalItem,
  MemoryRetrievalResult,
} from "../../memory/retrieval.ts";

export type HostMemoryHost = "claude_code" | "openclaw" | "hermes";

export type HostMemoryOutcome = "success" | "failure" | "unknown";

export interface HostMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
}

export interface HostRecallInput {
  host: HostMemoryHost;
  sessionId: string;
  userPrompt: string;
  recentMessages?: HostMessage[];
  cwd?: string;
  resourceHints?: string[];
  tokenBudget?: number;
  branchRef?: string;
  limit?: number;
}

export interface InjectedMemoryContext {
  format: "xml_tagged";
  text: string;
  memoryIds: string[];
  provenance: Array<{
    memoryId: string;
    source: "history" | "resource" | "relation";
    score: number;
  }>;
}

export interface HostCaptureInput {
  host: HostMemoryHost;
  sessionId: string;
  outcome: HostMemoryOutcome;
  userPrompt?: string;
  finalAssistantMessage?: string;
  messages?: HostMessage[];
  transcriptPath?: string;
  toolEvents?: Array<Record<string, unknown>>;
  errorSummary?: string;
  branchRef?: string;
  title?: string;
}

export interface MemoryCaptureResult {
  status: "captured";
  resourceId: string;
  revisionId: string;
  chunkIds: string[];
  commitIds: string[];
  extractionCandidates: Array<Record<string, unknown>>;
  extra?: Record<string, unknown>;
}

export function hostRecallInput(payload: Record<string, unknown>): HostRecallInput {
  const host = requiredString(payload, "host") as HostMemoryHost;
  if (host !== "claude_code" && host !== "openclaw" && host !== "hermes") {
    throw new Error(`unsupported host: ${host}`);
  }
  return {
    host,
    sessionId: optionalString(payload, "sessionId") ?? `${host}:session`,
    userPrompt: requiredString(payload, "userPrompt"),
    ...(hostMessages(payload.recentMessages, "recentMessages") === undefined
      ? {}
      : {
          recentMessages: hostMessages(
            payload.recentMessages,
            "recentMessages",
          ) as HostMessage[],
        }),
    ...(optionalString(payload, "cwd") === undefined
      ? {}
      : { cwd: optionalString(payload, "cwd") as string }),
    ...(strings(payload.resourceHints) === undefined
      ? {}
      : { resourceHints: strings(payload.resourceHints) as string[] }),
    ...(numberValue(payload, "tokenBudget") === undefined
      ? {}
      : { tokenBudget: numberValue(payload, "tokenBudget") as number }),
    ...(optionalString(payload, "branchRef") === undefined
      ? {}
      : { branchRef: optionalString(payload, "branchRef") as string }),
    ...(numberValue(payload, "limit") === undefined
      ? {}
      : { limit: numberValue(payload, "limit") as number }),
  };
}

export function hostCaptureInput(payload: Record<string, unknown>): HostCaptureInput {
  const host = requiredString(payload, "host") as HostMemoryHost;
  if (host !== "claude_code" && host !== "openclaw" && host !== "hermes") {
    throw new Error(`unsupported host: ${host}`);
  }
  const outcome =
    (optionalString(payload, "outcome") as HostMemoryOutcome | undefined) ??
    "unknown";
  if (outcome !== "success" && outcome !== "failure" && outcome !== "unknown") {
    throw new Error("unsupported outcome: " + outcome);
  }
  return {
    host,
    sessionId: optionalString(payload, "sessionId") ?? `${host}:session`,
    outcome,
    ...(optionalString(payload, "userPrompt") === undefined
      ? {}
      : { userPrompt: optionalString(payload, "userPrompt") as string }),
    ...(optionalString(payload, "finalAssistantMessage") === undefined
      ? {}
      : {
          finalAssistantMessage: optionalString(
            payload,
            "finalAssistantMessage",
          ) as string,
        }),
    ...(hostMessages(payload.messages, "messages") === undefined
      ? {}
      : {
          messages: hostMessages(
            payload.messages,
            "messages",
          ) as HostMessage[],
        }),
    ...(optionalString(payload, "transcriptPath") === undefined
      ? {}
      : { transcriptPath: optionalString(payload, "transcriptPath") as string }),
    ...(toolEvents(payload.toolEvents) === undefined
      ? {}
      : { toolEvents: toolEvents(payload.toolEvents) as Array<Record<string, unknown>> }),
    ...(optionalString(payload, "errorSummary") === undefined
      ? {}
      : { errorSummary: optionalString(payload, "errorSummary") as string }),
    ...(optionalString(payload, "branchRef") === undefined
      ? {}
      : { branchRef: optionalString(payload, "branchRef") as string }),
    ...(optionalString(payload, "title") === undefined
      ? {}
      : { title: optionalString(payload, "title") as string }),
  };
}

export function formatInjectedMemoryContext(
  host: HostMemoryHost,
  result: MemoryRetrievalResult,
): InjectedMemoryContext {
  const items = rankByDescendingScoreShare(result.items);
  const sections = items.map((item, index) =>
    `<memory index="${index + 1}" id="${escapeXml(memoryItemId(item))}" score="${item.score.toFixed(3)}" source="${memoryItemSource(item)}">\n${escapeXml(memoryItemText(item))}\n</memory>`,
  );
  const text = [
    `<team-memory-context trust="untrusted" host="${host}" root="${escapeXml(result.rootEntityId)}" branch="${escapeXml(result.branchRef)}">`,
    ...sections,
    "</team-memory-context>",
  ].join("\n");
  return {
    format: "xml_tagged",
    text,
    memoryIds: items.map(memoryItemId),
    provenance: items.map((item) => ({
      memoryId: memoryItemId(item),
      source: memoryItemSource(item),
      score: item.score,
    })),
  };
}

function rankByDescendingScoreShare(
  items: MemoryRetrievalItem[],
): MemoryRetrievalItem[] {
  const totalScore = items.reduce((total, item) => total + item.score, 0);
  return items
    .map((item, index) => ({
      item,
      index,
      scoreShare: totalScore > 0 ? item.score / totalScore : 0,
    }))
    .sort(
      (left, right) =>
        right.scoreShare - left.scoreShare || left.index - right.index,
    )
    .map(({ item }) => item);
}

function memoryItemId(item: MemoryRetrievalItem): string {
  if (item.kind === "entity") return item.branch?.id ?? item.entity.id;
  if (item.kind === "resource_chunk") return item.chunk.id;
  return item.relation.id;
}

function memoryItemSource(item: MemoryRetrievalItem): "history" | "resource" | "relation" {
  if (item.kind === "resource_chunk") return "resource";
  if (item.kind === "relation") return "relation";
  return "history";
}

function memoryItemText(item: MemoryRetrievalItem): string {
  if (item.kind === "entity") {
    const branch = item.branch;
    const primary = branch === undefined
      ? [
          `Title: ${item.entity.name ?? item.entity.title ?? item.entity.id}`,
          item.entity.description === undefined
            ? ""
            : `Description: ${item.entity.description}`,
          item.entity.tags === undefined || item.entity.tags.length === 0
            ? ""
            : `Tags: ${item.entity.tags.join(", ")}`,
        ]
      : [
          `Title: ${branch.title}`,
          `Description: ${branch.description}`,
          branch.tags.length === 0 ? "" : `Tags: ${branch.tags.join(", ")}`,
          branch.extraInfo === undefined
            ? ""
            : `Extra: ${JSON.stringify(branch.extraInfo)}`,
        ];
    const packedEntities = (item.packedEntities ?? []).flatMap((entity) => [
      `Related entity: ${entity.name ?? entity.title ?? entity.id}`,
      entity.description === undefined
        ? ""
        : `Related entity description: ${entity.description}`,
    ]);
    const packedBranches = (item.packedBranches ?? []).flatMap((packed) => [
      `Related fact: ${packed.title}`,
      `Related fact description: ${packed.description}`,
      packed.extraInfo === undefined
        ? ""
        : `Related fact extra: ${JSON.stringify(packed.extraInfo)}`,
    ]);
    const packedRelations = (item.packedRelations ?? []).map((relation) =>
      `Relation: ${relation.sourceId} ${relation.relationType} ${relation.targetId}`
    );
    const evidence = item.evidence.map((chunk) =>
      `Evidence: ${chunk.text}`
    );
    return [
      ...primary,
      ...packedEntities,
      ...packedBranches,
      ...packedRelations,
      ...evidence,
    ].filter((line) => line.length > 0).join("\n");
  }
  if (item.kind === "resource_chunk") {
    return item.chunk.text;
  }
  return [
    `Relation: ${item.relation.sourceKind}:${item.relation.sourceId} ${item.relation.relationType} ${item.relation.targetKind}:${item.relation.targetId}`,
    item.relation.role === undefined ? "" : `Role: ${item.relation.role}`,
  ].filter((line) => line.length > 0).join("\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function numberValue(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  return value as number;
}

function strings(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("resourceHints must be an array of strings");
  }
  return value;
}

function hostMessages(
  value: unknown,
  field: "messages" | "recentMessages",
): HostMessage[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(field + " must be an array");
  return value.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(field + " entries must be objects");
    }
    const record = item as Record<string, unknown>;
    const role = record.role;
    const content = record.content;
    if (
      role !== "user" &&
      role !== "assistant" &&
      role !== "system" &&
      role !== "tool"
    ) {
      throw new Error(field + ".role is invalid");
    }
    if (typeof content !== "string") {
      throw new Error(field + ".content is required");
    }
    return { role, content };
  });
}

function toolEvents(value: unknown): Array<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("toolEvents must be an array");
  return value.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("toolEvents entries must be objects");
    }
    return item as Record<string, unknown>;
  });
}
