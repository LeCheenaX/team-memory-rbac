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
    additionalProperties: true;
  };
}

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
      this.tool("team_memory.search", "Search RBAC-protected Team Memory"),
      this.tool("team_memory.catalog", "List visible Team Memory names and tags"),
      this.tool("team_memory.write", "Write RBAC-protected Team Memory"),
    ];
    if (this.mode === "parallel_native_team_memory") return common;
    return [
      this.tool("memory_search", "OpenClaw active-memory recall through Team Memory"),
      this.tool("memory_catalog", "OpenClaw active-memory catalog through Team Memory"),
      this.tool("memory_write", "OpenClaw active-memory write through Team Memory"),
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

  private tool(name: string, description: string): OpenClawToolDefinition {
    return {
      name,
      description,
      inputSchema: { type: "object", additionalProperties: true },
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
