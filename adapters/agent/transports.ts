import type { PrincipalContext } from "../../src/contracts/rbac.ts";
import type { AgentSessionAuthority } from "../../src/agent/session.ts";
import type {
  VisibleAgentTool,
} from "../../src/agent/tools.ts";
import { ToolPermissionAdapter } from "../../src/agent/tools.ts";
import type {
  PermissionRouteResult,
} from "../../src/permission-router.ts";
import type { TeamMemoryGateway } from "../runtime/gateway.ts";

export interface PrincipalContextTransport {
  resolvePrincipal(sessionToken: string): Promise<PrincipalContext>;
}

class SessionTransportAdapter implements PrincipalContextTransport {
  private readonly sessions: AgentSessionAuthority;
  private readonly tools: ToolPermissionAdapter | undefined;

  constructor(
    sessions: AgentSessionAuthority,
    tools?: ToolPermissionAdapter,
  ) {
    this.sessions = sessions;
    this.tools = tools;
  }

  resolvePrincipal(sessionToken: string): Promise<PrincipalContext> {
    return this.sessions.resolve(sessionToken);
  }

  listTools(sessionToken: string): Promise<VisibleAgentTool[]> {
    if (this.tools === undefined) {
      throw new Error("tool adapter is not configured");
    }
    return this.tools.listVisibleTools(sessionToken);
  }

  invokeTool(
    sessionToken: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionRouteResult<unknown>> {
    if (this.tools === undefined) {
      throw new Error("tool adapter is not configured");
    }
    return this.tools.invoke(sessionToken, toolName, input);
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
