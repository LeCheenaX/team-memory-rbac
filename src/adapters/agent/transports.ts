import type { PrincipalContext } from "../../contracts/rbac.ts";
import type { AgentSessionAuthority } from "../../agent/session.ts";
import type {
  VisibleAgentTool,
} from "../../agent/tools.ts";
import { ToolPermissionAdapter } from "../../agent/tools.ts";
import type {
  PermissionRouteResult,
} from "../../permission-router.ts";
import type { TeamMemoryGateway } from "../runtime/gateway.ts";

export const AGENT_MEMORY_INTEGRATION_MODES = [
  "parallel_native_team_memory",
  "team_memory_replaces_native",
] as const;

export type AgentMemoryIntegrationMode =
  (typeof AGENT_MEMORY_INTEGRATION_MODES)[number];

export type AgentRuntimeHost =
  | "http"
  | "mcp"
  | "openclaw"
  | "codex"
  | "claude_code"
  | "hermes";

export interface AgentMemoryIntegrationPlan {
  host: AgentRuntimeHost;
  displayName: string;
  mode: AgentMemoryIntegrationMode;
  connector:
    | "http"
    | "mcp"
    | "claude_code_hooks"
    | "openclaw_tool_plugin"
    | "openclaw_active_memory_plugin"
    | "python_adapter"
    | "hermes_memory_provider";
  nativeMemory: {
    disposition:
      | "preserved"
      | "disabled"
      | "replaced_by_team_memory"
      | "not_applicable";
    controls: string[];
  };
  hostConfiguration: {
    actions: string[];
    settings: Record<string, unknown>;
  };
  identitySource: "trusted_session";
  principal: PrincipalContext;
  teamMemory: {
    canRead: boolean;
    canWrite: boolean;
    readTools: string[];
    writeTools: string[];
    visibleTools: VisibleAgentTool[];
  };
}

interface AgentRuntimeProfile {
  host: AgentRuntimeHost;
  displayName: string;
  connector: AgentMemoryIntegrationPlan["connector"];
  supportedMemoryModes: readonly AgentMemoryIntegrationMode[];
  plan(
    mode: AgentMemoryIntegrationMode,
  ): Pick<
    AgentMemoryIntegrationPlan,
    "connector" | "nativeMemory" | "hostConfiguration"
  >;
}

export interface PrincipalContextTransport {
  resolvePrincipal(sessionToken: string): Promise<PrincipalContext>;
}

const allMemoryModes = AGENT_MEMORY_INTEGRATION_MODES;

const HTTP_PROFILE: AgentRuntimeProfile = {
  host: "http",
  displayName: "HTTP",
  connector: "http",
  supportedMemoryModes: allMemoryModes,
  plan: (mode) => ({
    connector: "http",
    nativeMemory: {
      disposition:
        mode === "parallel_native_team_memory"
          ? "preserved"
          : "not_applicable",
      controls: [],
    },
    hostConfiguration: {
      actions: ["Call Team Memory HTTP endpoints with a trusted agent token"],
      settings: {},
    },
  }),
};

const MCP_PROFILE: AgentRuntimeProfile = {
  host: "mcp",
  displayName: "MCP",
  connector: "mcp",
  supportedMemoryModes: allMemoryModes,
  plan: (mode) => ({
    connector: "mcp",
    nativeMemory: {
      disposition:
        mode === "parallel_native_team_memory"
          ? "preserved"
          : "not_applicable",
      controls: [],
    },
    hostConfiguration: {
      actions: ["Register the Team Memory MCP server"],
      settings: {},
    },
  }),
};

const OPENCLAW_PROFILE: AgentRuntimeProfile = {
  host: "openclaw",
  displayName: "OpenClaw",
  connector: "openclaw_tool_plugin",
  supportedMemoryModes: allMemoryModes,
  plan: (mode) =>
    mode === "parallel_native_team_memory"
      ? {
          connector: "openclaw_tool_plugin",
          nativeMemory: {
            disposition: "preserved",
            controls: [
              "Keep the existing plugins.slots.memory owner active",
              "Keep MEMORY.md, memory/*.md, and DREAMS.md available to OpenClaw",
            ],
          },
          hostConfiguration: {
            actions: [
              "Install a Team Memory OpenClaw tool plugin",
              "Expose RBAC-protected team_memory.search and team_memory.write tools",
              "Enable OpenClaw agent_end autoCapture to route session captures through Team Memory",
              "Optionally add an OpenClaw skill that teaches when to call Team Memory",
            ],
            settings: {
              autoCapture: {
                event: "agent_end",
                endpoint: "/host/openclaw/capture",
                layers: [
                  "L3:memory_entity",
                  "L2:memory_entity_branch",
                  "L1:conversation_resource",
                  "L1:resource_chunk",
                  "L2:memory_relation",
                ],
              },
            },
          },
        }
      : {
          connector: "openclaw_active_memory_plugin",
          nativeMemory: {
            disposition: "replaced_by_team_memory",
            controls: [
              "Set plugins.slots.memory to the Team Memory plugin id",
              "Implement the active memory plugin tool contract for recall",
            ],
          },
          hostConfiguration: {
            actions: [
              "Register Team Memory as the active memory plugin",
              "Expose memory_search and memory_catalog-compatible tools backed by Team Memory",
              "Route promotion and write tools through the Team Memory gateway",
              "Enable OpenClaw agent_end autoCapture to route session captures through Team Memory",
            ],
            settings: {
              "plugins.slots.memory": "team-memory-rbac",
              autoCapture: {
                event: "agent_end",
                endpoint: "/host/openclaw/capture",
                layers: [
                  "L3:memory_entity",
                  "L2:memory_entity_branch",
                  "L1:conversation_resource",
                  "L1:resource_chunk",
                  "L2:memory_relation",
                ],
              },
            },
          },
        },
};

const CODEX_PROFILE: AgentRuntimeProfile = {
  host: "codex",
  displayName: "Codex",
  connector: "mcp",
  supportedMemoryModes: allMemoryModes,
  plan: MCP_PROFILE.plan,
};

const CLAUDE_CODE_PROFILE: AgentRuntimeProfile = {
  host: "claude_code",
  displayName: "Claude Code",
  connector: "claude_code_hooks",
  supportedMemoryModes: allMemoryModes,
  plan: (mode) =>
    mode === "parallel_native_team_memory"
      ? {
          connector: "claude_code_hooks",
          nativeMemory: {
            disposition: "preserved",
            controls: [
              "Keep Claude Code auto memory enabled",
              "Allow subagent memory frontmatter when wanted",
            ],
          },
          hostConfiguration: {
            actions: [
              "Register a Claude Code UserPromptSubmit hook that calls Team Memory recall",
              "Register Claude Code Stop, StopFailure, SessionEnd, TeammateIdle, and PreCompact hooks that call Team Memory capture",
              "Optionally keep Team Memory MCP tools for explicit agent reads and writes",
            ],
            settings: {
              "hooks.UserPromptSubmit": "/host/claude_code/recall",
              "hooks.Stop": "/host/claude_code/capture",
              "hooks.StopFailure": "/host/claude_code/capture",
              "hooks.SessionEnd": "/host/claude_code/capture",
              "hooks.TeammateIdle": "/host/claude_code/capture",
              "hooks.PreCompact": "/host/claude_code/capture",
            },
          },
        }
      : {
          connector: "claude_code_hooks",
          nativeMemory: {
            disposition: "disabled",
            controls: [
              "Set autoMemoryEnabled to false or CLAUDE_CODE_DISABLE_AUTO_MEMORY=1",
              "Do not set subagent memory frontmatter for Team Memory-only agents",
            ],
          },
          hostConfiguration: {
            actions: [
              "Disable Claude Code auto memory",
              "Register Team Memory lifecycle hooks as the only automatic long-term memory path",
              "Optionally expose Team Memory MCP tools for explicit agent reads and writes",
            ],
            settings: {
              autoMemoryEnabled: false,
              CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
              "hooks.UserPromptSubmit": "/host/claude_code/recall",
              "hooks.Stop": "/host/claude_code/capture",
              "hooks.StopFailure": "/host/claude_code/capture",
              "hooks.SessionEnd": "/host/claude_code/capture",
              "hooks.TeammateIdle": "/host/claude_code/capture",
              "hooks.PreCompact": "/host/claude_code/capture",
            },
          },
        },
};

const HERMES_PROFILE: AgentRuntimeProfile = {
  host: "hermes",
  displayName: "Hermes",
  connector: "hermes_memory_provider",
  supportedMemoryModes: allMemoryModes,
  plan: (mode) => ({
    connector: "hermes_memory_provider",
    nativeMemory: {
      disposition:
        mode === "parallel_native_team_memory"
          ? "preserved"
          : "replaced_by_team_memory",
      controls: [
        mode === "parallel_native_team_memory"
          ? "Keep Hermes official memory providers such as mem0 separate from the Team Memory provider namespace"
          : "Configure Team Memory as the authoritative Hermes long-term memory provider",
      ],
    },
    hostConfiguration: {
      actions: [
        "Register the Team Memory Hermes provider at the same memory-plugin seam as mem0-style providers",
        "Use prefetch, queue_prefetch, sync_turn, on_pre_compress, on_session_end, on_memory_write, and shutdown lifecycle hooks for automatic read/write and observability",
        "Keep authorization, memory writes, retrieval, and history in the TypeScript core",
      ],
      settings: {
        "memory.provider": "team_memory",
        "memory.hooks": [
          "prefetch",
          "queue_prefetch",
          "sync_turn",
          "on_pre_compress",
          "on_session_end",
          "on_memory_write",
          "shutdown",
        ],
        captureLayers: [
          "L3:memory_entity",
          "L2:memory_entity_branch",
          "L1:conversation_resource",
          "L1:resource_chunk",
          "L2:memory_relation",
        ],
      },
    },
  }),
};

class SessionTransportAdapter implements PrincipalContextTransport {
  private readonly sessions: AgentSessionAuthority | undefined;
  private readonly tools: ToolPermissionAdapter | undefined;
  private readonly gateway: TeamMemoryGateway | undefined;
  private readonly gatewayTools: McpTeamMemoryAdapter | undefined;
  private readonly profile: AgentRuntimeProfile;

  constructor(
    sessionsOrGateway: AgentSessionAuthority | TeamMemoryGateway,
    tools?: ToolPermissionAdapter,
    profile: AgentRuntimeProfile = HTTP_PROFILE,
  ) {
    if ("authenticate" in sessionsOrGateway) {
      this.gateway = sessionsOrGateway;
      this.gatewayTools = new McpTeamMemoryAdapter(sessionsOrGateway);
    } else {
      this.sessions = sessionsOrGateway;
    }
    this.tools = tools;
    this.profile = profile;
  }

  get host(): AgentRuntimeHost {
    return this.profile.host;
  }

  get supportedMemoryModes(): AgentMemoryIntegrationMode[] {
    return [...this.profile.supportedMemoryModes];
  }

  async resolvePrincipal(sessionToken: string): Promise<PrincipalContext> {
    if (this.sessions !== undefined) {
      return this.sessions.resolve(sessionToken);
    }
    const session = await this.requireGateway().authenticate(sessionToken);
    if (session.principal === undefined) {
      throw new Error("runtime adapter requires an agent session");
    }
    return session.principal;
  }

  listTools(sessionToken: string): Promise<VisibleAgentTool[]> {
    if (this.gateway !== undefined) {
      return this.gateway.listAgentTools(sessionToken);
    }
    if (this.tools === undefined) {
      throw new Error("tool adapter is not configured");
    }
    return this.tools.listVisibleTools(sessionToken);
  }

  async invokeTool(
    sessionToken: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionRouteResult<unknown>> {
    if (this.gatewayTools !== undefined) {
      const decision = await this.requireGateway().authorizeAgentTool(
        sessionToken,
        toolName,
      );
      if (!decision.allowed) {
        return { decision: decision as typeof decision & { allowed: false } };
      }
      const value = await this.gatewayTools.callTool(sessionToken, toolName, input);
      if (
        value !== null &&
        typeof value === "object" &&
        "decision" in value
      ) {
        return value as PermissionRouteResult<unknown>;
      }
      return { decision: decision as typeof decision & { allowed: true }, value };
    }
    if (this.tools === undefined) {
      throw new Error("tool adapter is not configured");
    }
    return this.tools.invoke(sessionToken, toolName, input);
  }

  async createMemoryIntegrationPlan(
    sessionToken: string,
    mode: AgentMemoryIntegrationMode,
  ): Promise<AgentMemoryIntegrationPlan> {
    if (!this.profile.supportedMemoryModes.includes(mode)) {
      throw new Error(
        `${this.profile.displayName} does not support memory mode ${mode}`,
      );
    }
    const [principal, visibleTools] = await Promise.all([
      this.resolvePrincipal(sessionToken),
      this.listTools(sessionToken),
    ]);
    const readTools = visibleTools
      .map((tool) => tool.name)
      .filter((name) =>
        [
          "memory.search",
          "memory.catalog",
        ].includes(name),
      );
    const writeTools = visibleTools
      .map((tool) => tool.name)
      .filter((name) => ["memory.write"].includes(name));
    return {
      host: this.profile.host,
      displayName: this.profile.displayName,
      mode,
      ...this.profile.plan(mode),
      identitySource: "trusted_session",
      principal,
      teamMemory: {
        canRead: readTools.length > 0,
        canWrite: writeTools.includes("memory.write"),
        readTools,
        writeTools,
        visibleTools,
      },
    };
  }

  private requireGateway(): TeamMemoryGateway {
    if (this.gateway === undefined) {
      throw new Error("runtime gateway is not configured");
    }
    return this.gateway;
  }
}

export class HttpAgentAdapter extends SessionTransportAdapter {
  constructor(
    sessionsOrGateway: AgentSessionAuthority | TeamMemoryGateway,
    tools?: ToolPermissionAdapter,
  ) {
    super(sessionsOrGateway, tools, HTTP_PROFILE);
  }
}

export class McpAgentAdapter extends SessionTransportAdapter {
  constructor(
    sessionsOrGateway: AgentSessionAuthority | TeamMemoryGateway,
    tools?: ToolPermissionAdapter,
  ) {
    super(sessionsOrGateway, tools, MCP_PROFILE);
  }
}

export class OpenClawAgentAdapter extends SessionTransportAdapter {
  constructor(
    sessionsOrGateway: AgentSessionAuthority | TeamMemoryGateway,
    tools?: ToolPermissionAdapter,
  ) {
    super(sessionsOrGateway, tools, OPENCLAW_PROFILE);
  }
}

export class CodexAgentAdapter extends SessionTransportAdapter {
  constructor(
    sessionsOrGateway: AgentSessionAuthority | TeamMemoryGateway,
    tools?: ToolPermissionAdapter,
  ) {
    super(sessionsOrGateway, tools, CODEX_PROFILE);
  }
}

export class ClaudeCodeAgentAdapter extends SessionTransportAdapter {
  constructor(
    sessionsOrGateway: AgentSessionAuthority | TeamMemoryGateway,
    tools?: ToolPermissionAdapter,
  ) {
    super(sessionsOrGateway, tools, CLAUDE_CODE_PROFILE);
  }
}

export class HermesAgentAdapter extends SessionTransportAdapter {
  constructor(
    sessionsOrGateway: AgentSessionAuthority | TeamMemoryGateway,
    tools?: ToolPermissionAdapter,
  ) {
    super(sessionsOrGateway, tools, HERMES_PROFILE);
  }
}

export class McpTeamMemoryAdapter {
  private readonly gateway: TeamMemoryGateway;

  constructor(gateway: TeamMemoryGateway) {
    this.gateway = gateway;
  }

  listTools(): Array<{
    name: string;
    description: string;
    inputSchema: { type: "object"; properties: Record<string, unknown>; additionalProperties: false };
  }> {
    return [
      {
        name: "memory.catalog",
        description: "List visible MemoryEntity names and plain tag strings sorted by descending visible entity count with deterministic ties. Counts and generated ids are not exposed.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "memory.search",
        description: "Search Team Memory with query, optional limit, layer, names, and tagsAny. Copy tagsAny values exactly from memory.catalog; if no suitable visible tag exists, use names or query instead of inventing one.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer" },
            layer: { type: "string", enum: ["L1", "L2", "L3"] },
            names: { type: "array", items: { type: "string" } },
            tagsAny: {
              type: "array",
              items: { type: "string" },
              description: "Visible tag strings copied from memory.catalog; these are filters, not inferred keywords.",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "memory.write",
        description: "Write durable Team Memory using structured operations.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ];
  }

  async callTool(
    sessionToken: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    switch (toolName) {
      case "memory.importResource":
        return this.gateway.importResource(sessionToken, input);
      case "memory.ingestResource":
        return this.gateway.ingestResource(
          sessionToken,
          this.requiredString(input, "resourceId"),
          input,
        );
      case "memory.readResource":
        return this.gateway.readResource(
          sessionToken,
          this.requiredString(input, "resourceId"),
          typeof input.revisionId === "string" ? input.revisionId : undefined,
        );
      case "memory.catalog":
        return this.gateway.memoryCatalog(sessionToken, input);
      case "memory.write":
        return this.gateway.writeMemory(sessionToken, input);
      case "memory.search":
        return this.gateway.searchMemory(sessionToken, input);
      case "memory.history":
        return this.gateway.listHistory(sessionToken, input);
      case "memory.conflicts":
        return this.gateway.listConflicts(sessionToken, input);
      case "memory.resolveConflict":
        return this.gateway.resolveConflict(sessionToken, input);
      case "memory.syncPull":
        return this.gateway.pullSync(sessionToken, input);
      default:
        throw new Error(`unknown MCP tool: ${toolName}`);
    }
  }

  private requiredString(
    input: Record<string, unknown>,
    key: string,
  ): string {
    const value = input[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${key} is required`);
    }
    return value;
  }
}
