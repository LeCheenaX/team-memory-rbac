import { TeamMemoryHttpClient } from "../http/client.ts";
import { LocalTeamMemoryClient } from "../local/client.ts";
import type { TeamMemoryGateway } from "../runtime/gateway.ts";
import type {
  AgentMemoryIntegrationMode,
} from "../agent/transports.ts";

export interface OpenClawTeamMemoryClient {
  search(input: Record<string, unknown>): Promise<unknown>;
  catalog(input?: Record<string, unknown>): Promise<unknown>;
  write(input: Record<string, unknown>): Promise<unknown>;
  importResource(input: Record<string, unknown>): Promise<unknown>;
  ingestResource(resourceId: string, input: Record<string, unknown>): Promise<unknown>;
  readResource(resourceId: string, revisionId?: string): Promise<unknown>;
  recallHostMemory(host: string, input: Record<string, unknown>): Promise<unknown>;
  captureHostMemory(host: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface OpenClawTeamMemoryHttpOptions {
  baseUrl: string;
  token: string;
  mode: AgentMemoryIntegrationMode;
  fetch?: typeof fetch;
}

export interface OpenClawTeamMemoryLocalOptions {
  mode: AgentMemoryIntegrationMode;
  client: OpenClawTeamMemoryClient;
}

export type OpenClawTeamMemoryPluginOptions =
  | OpenClawTeamMemoryHttpOptions
  | OpenClawTeamMemoryLocalOptions;

export interface OpenClawToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
}

type OpenClawInputSchema = OpenClawToolDefinition["inputSchema"];

function structuredWriteToolDescription(): string {
  return [
    "Write durable Team Memory using structured operations[].",
    "Extract entity summaries, atomic branch facts, and MemoryRelation edges before writing.",
    "Few-shot: memory_entity/create plus memory_entity_branch/create for a new project; memory_entity/refresh for summary refresh; memory_entity_branch/create for duplicate facts so branch vector dedupe can update metadata; memory_relation/create with type relates_to for related facts; memory_relation/create with type contradicts between branch natural-name endpoints for conflicts.",
    "Never send raw transcript-as-memory, Agent-authored ResourceChunk, clientMutationId, branchRef, expectedHeadCommitId, top-level payload.conflict, generated ids, identity/root fields, or outcome-as-semantic-content.",
  ].join(" ");
}

const emptySchema: OpenClawInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const searchSchema: OpenClawInputSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    text: { type: "string" },
    limit: { type: "integer" },
    layer: { type: "string", enum: ["L1", "L2", "L3"] },
    names: { type: "array", items: { type: "string" } },
    tagsAny: {
      type: "array",
      items: { type: "string" },
      description: "Exact visible tag strings copied from memory_catalog or team_memory.catalog; these are filters, not inferred keywords.",
    },
  },
  additionalProperties: false,
};

const writeSchema: OpenClawInputSchema = {
  type: "object",
  properties: {
    operations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: ["memory_entity", "memory_entity_branch", "memory_relation", "resource"],
          },
          op: {
            type: "string",
            enum: ["create", "update", "refresh", "update_metadata", "replace"],
          },
          name: { type: "string" },
          type: {
            type: "string",
            enum: ["has", "depends_on", "relates_to", "refers_to", "contradicts", "supersedes", "next_is"],
          },
          subject: { type: ["object", "string"] },
          object: { type: ["object", "string"] },
          properties: { type: "object" },
        },
        required: ["target", "op"],
        additionalProperties: false,
      },
    },
  },
  required: ["operations"],
  additionalProperties: false,
};

const importResourceSchema: OpenClawInputSchema = {
  type: "object",
  properties: {
    clientMutationId: { type: "string" },
    title: { type: "string" },
    sourceType: { type: "string" },
    content: { type: "string" },
    contentBase64: { type: "string" },
    uri: { type: "string" },
    metadata: { type: "object" },
    maxChunkCharacters: { type: "integer" },
  },
  required: ["clientMutationId", "title", "sourceType"],
  additionalProperties: false,
};

const ingestResourceSchema: OpenClawInputSchema = {
  type: "object",
  properties: {
    resourceId: { type: "string" },
    clientMutationId: { type: "string" },
    revisionId: { type: "string" },
    maxChunkCharacters: { type: "integer" },
  },
  required: ["resourceId", "clientMutationId"],
  additionalProperties: false,
};

const readResourceSchema: OpenClawInputSchema = {
  type: "object",
  properties: {
    resourceId: { type: "string" },
    revisionId: { type: "string" },
  },
  required: ["resourceId"],
  additionalProperties: false,
};

/** Host-facing OpenClaw adapter for both tool-plugin and active-memory modes. */
export class OpenClawTeamMemoryPlugin {
  readonly id = "team-memory-rbac";
  readonly mode: AgentMemoryIntegrationMode;
  private readonly client: OpenClawTeamMemoryClient;

  constructor(options: OpenClawTeamMemoryPluginOptions) {
    this.mode = options.mode;
    this.client = "client" in options
      ? options.client
      : new TeamMemoryHttpClient(options);
  }

  static fromGateway(options: {
    gateway: TeamMemoryGateway;
    token: string;
    mode: AgentMemoryIntegrationMode;
  }): OpenClawTeamMemoryPlugin {
    return new OpenClawTeamMemoryPlugin({
      mode: options.mode,
      client: new LocalTeamMemoryClient(options.gateway, options.token),
    });
  }

  tools(): OpenClawToolDefinition[] {
    const common = [
      this.tool("team_memory.search", "Search RBAC-protected Team Memory with query, optional layer, names, tagsAny, and limit. Copy every tagsAny value exactly from team_memory.catalog; if no suitable visible tag exists, use names or query instead of inventing one. Do not send identity fields, generated ids, history toggles, or conflict flags.", searchSchema),
      this.tool("team_memory.catalog", "List visible Team Memory names and plain tag strings from the trusted session root. Tags are sorted by descending visible entity count with deterministic ties; counts and generated ids are not exposed.", emptySchema),
      this.tool("team_memory.write", structuredWriteToolDescription(), writeSchema),
      this.tool("team_memory.import_resource", "Import a host-facing Resource and automatically ingest its current revision.", importResourceSchema),
      this.tool("team_memory.ingest_resource", "Retry or rebuild ingestion for an existing Resource revision.", ingestResourceSchema),
      this.tool("team_memory.read_resource", "Read a Resource by generated resourceId, optionally at a revision.", readResourceSchema),
    ];
    if (this.mode === "parallel_native_team_memory") return common;
    return [
      this.tool("memory_search", "OpenClaw active-memory recall through Team Memory with query, optional layer, names, tagsAny, and limit. Copy every tagsAny value exactly from memory_catalog; if no suitable visible tag exists, use names or query instead of inventing one. Do not send identity fields, generated ids, history toggles, or conflict flags.", searchSchema),
      this.tool("memory_catalog", "OpenClaw active-memory catalog with visible names and plain tag strings sorted by descending visible entity count with deterministic ties. Counts and generated ids are not exposed.", emptySchema),
      this.tool("memory_write", structuredWriteToolDescription(), writeSchema),
      this.tool("memory_import", "Import a host-facing Resource and automatically ingest its current revision.", importResourceSchema),
      this.tool("memory_ingest", "Retry or rebuild ingestion for an existing Resource revision.", ingestResourceSchema),
      this.tool("memory_get", "Read a Resource by generated resourceId, optionally at a revision.", readResourceSchema),
    ];
  }

  async call(name: string, input: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "team_memory.search":
      case "memory_search":
        return this.client.search(this.normalizeSearch(input));
      case "team_memory.catalog":
      case "memory_catalog":
        return this.client.catalog({});
      case "team_memory.write":
      case "memory_write":
        return this.client.write(input);
      case "team_memory.import_resource":
      case "memory_import":
        return this.client.importResource(input);
      case "team_memory.ingest_resource":
      case "memory_ingest":
        return this.client.ingestResource(
          this.requiredString(input, "resourceId"),
          input,
        );
      case "team_memory.read_resource":
      case "memory_get":
        return this.client.readResource(
          this.requiredString(input, "resourceId"),
          typeof input.revisionId === "string" ? input.revisionId : undefined,
        );
      default:
        throw new Error(`unknown OpenClaw Team Memory tool: ${name}`);
    }
  }

  async recallContext(input: {
    sessionId: string;
    userPrompt: string;
    recentMessages?: Array<{ role: "user" | "assistant" | "system" | "tool"; content: string }>;
    limit?: number;
  }): Promise<unknown> {
    return this.client.recallHostMemory("openclaw", input);
  }

  async capturePath(input: {
    sessionId: string;
    outcome: "success" | "failure" | "unknown";
    userPrompt?: string;
    finalAssistantMessage?: string;
    errorSummary?: string;
    toolEvents?: Array<Record<string, unknown>>;
  }): Promise<unknown> {
    return this.client.captureHostMemory("openclaw", input);
  }

  async agentEnd(input: {
    sessionId: string;
    outcome?: "success" | "failure" | "unknown";
    userPrompt?: string;
    finalAssistantMessage?: string;
    errorSummary?: string;
    toolEvents?: Array<Record<string, unknown>>;
  }): Promise<unknown> {
    return this.capturePath({
      ...input,
      outcome: input.outcome ?? "success",
    });
  }

  manifest(): Record<string, unknown> {
    return {
      id: this.id,
      name: "Team Memory RBAC",
      mode: this.mode,
      slot: this.mode === "team_memory_replaces_native" ? "memory" : undefined,
      tools: this.tools(),
      lifecycle: {
        recall: "host/openclaw/recall",
        capture: "host/openclaw/capture",
        autoCapture: {
          event: "agent_end",
          endpoint: "host/openclaw/capture",
          layers: [
            "L1:conversation_resource",
            "L1:resource_chunk",
            "candidate:structured_memory_operations",
          ],
        },
      },
    };
  }

  private normalizeSearch(input: Record<string, unknown>): Record<string, unknown> {
    if (typeof input.query === "string") return input;
    const text = this.requiredString(input, "text");
    return {
      query: text,
      ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
      ...(Array.isArray(input.tagsAny) ? { tagsAny: input.tagsAny } : {}),
      ...(Array.isArray(input.names) ? { names: input.names } : {}),
      ...(input.layer === "L1" || input.layer === "L2" || input.layer === "L3"
        ? { layer: input.layer }
        : {}),
    };
  }

  private tool(
    name: string,
    description: string,
    inputSchema: OpenClawInputSchema,
  ): OpenClawToolDefinition {
    return {
      name,
      description,
      inputSchema,
    };
  }

  private requiredString(input: Record<string, unknown>, key: string): string {
    const value = input[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${key} is required`);
    }
    return value;
  }
}

export function createOpenClawTeamMemoryPluginFromEnv(
  environment: Record<string, string | undefined>,
): OpenClawTeamMemoryPlugin {
  const baseUrl = environment.TEAM_MEMORY_URL;
  const token = environment.TEAM_MEMORY_TOKEN;
  const mode =
    environment.TEAM_MEMORY_MODE ?? "parallel_native_team_memory";
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error("TEAM_MEMORY_URL must be configured");
  }
  if (token === undefined || token.length === 0) {
    throw new Error("TEAM_MEMORY_TOKEN must be configured");
  }
  if (
    mode !== "parallel_native_team_memory" &&
    mode !== "team_memory_replaces_native"
  ) {
    throw new Error(`unsupported TEAM_MEMORY_MODE: ${mode}`);
  }
  return new OpenClawTeamMemoryPlugin({ baseUrl, token, mode });
}
