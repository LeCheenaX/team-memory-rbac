import type { PrincipalContext } from "../../src/contracts/rbac.ts";
import type { AgentSessionAuthority } from "../../src/agent/session.ts";
import type {
  VisibleAgentTool,
} from "../../src/agent/tools.ts";
import { ToolPermissionAdapter } from "../../src/agent/tools.ts";
import type {
  PermissionRouteResult,
} from "../../src/permission-router.ts";

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
