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

export interface PrincipalContextTransport {
  resolvePrincipal(sessionToken: string): Promise<PrincipalContext>;
}

class SessionTransportAdapter implements PrincipalContextTransport {
  private readonly sessions: AgentSessionAuthority | undefined;
  private readonly tools: ToolPermissionAdapter | undefined;
  private readonly gateway: TeamMemoryGateway | undefined;
  private readonly gatewayTools: McpTeamMemoryAdapter | undefined;

  constructor(
    sessionsOrGateway: AgentSessionAuthority | TeamMemoryGateway,
    tools?: ToolPermissionAdapter,
  ) {
    if ("authenticate" in sessionsOrGateway) {
      this.gateway = sessionsOrGateway;
      this.gatewayTools = new McpTeamMemoryAdapter(sessionsOrGateway);
    } else {
      this.sessions = sessionsOrGateway;
    }
    this.tools = tools;
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

  private requireGateway(): TeamMemoryGateway {
    if (this.gateway === undefined) {
      throw new Error("runtime gateway is not configured");
    }
    return this.gateway;
  }
}

export class HttpAgentAdapter extends SessionTransportAdapter {}
export class McpAgentAdapter extends SessionTransportAdapter {}
export class OpenClawAgentAdapter extends SessionTransportAdapter {}
export class CodexAgentAdapter extends SessionTransportAdapter {}
export class ClaudeCodeAgentAdapter extends SessionTransportAdapter {}
export class HermesAgentAdapter extends SessionTransportAdapter {}

export class McpTeamMemoryAdapter {
  private readonly gateway: TeamMemoryGateway;

  constructor(gateway: TeamMemoryGateway) {
    this.gateway = gateway;
  }

  listTools(): Array<{
    name: string;
    inputSchema: { type: "object"; additionalProperties: true };
  }> {
    return [
      "memory.importResource",
      "memory.readResource",
      "memory.write",
      "memory.search",
      "memory.history",
      "memory.conflicts",
      "memory.resolveConflict",
      "memory.syncPull",
    ].map((name) => ({
      name,
      inputSchema: { type: "object", additionalProperties: true },
    }));
  }

  async callTool(
    sessionToken: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    switch (toolName) {
      case "memory.importResource":
        return this.gateway.importResource(sessionToken, input);
      case "memory.readResource":
        return this.gateway.readResource(
          sessionToken,
          this.requiredString(input, "resourceId"),
          typeof input.revisionId === "string" ? input.revisionId : undefined,
        );
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
