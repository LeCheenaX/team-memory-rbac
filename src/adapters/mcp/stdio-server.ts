import { stdin, stdout } from "node:process";
import { TeamMemoryHttpClient } from "../http/client.ts";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

const protocolVersion = "2024-11-05";

function toolInput(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const argumentsValue = params?.arguments;
  return argumentsValue !== null &&
    typeof argumentsValue === "object" &&
    !Array.isArray(argumentsValue)
    ? argumentsValue as Record<string, unknown>
    : {};
}

function textContent(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

export class TeamMemoryMcpStdioServer {
  private readonly client: TeamMemoryHttpClient;
  private readonly write: (payload: string) => void;
  private buffer = Buffer.alloc(0);

  constructor(
    client: TeamMemoryHttpClient,
    write: (payload: string) => void = (payload) => { stdout.write(payload); },
  ) {
    this.client = client;
    this.write = write;
  }

  start(): void {
    stdin.on("data", (chunk) => this.receive(Buffer.from(chunk)));
  }

  receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const separator = this.buffer.indexOf("\r\n\r\n");
      if (separator < 0) return;
      const header = this.buffer.subarray(0, separator).toString("utf8");
      const match = /^Content-Length:\s*(\d+)$/im.exec(header);
      if (match?.[1] === undefined) {
        throw new Error("missing Content-Length header");
      }
      const length = Number(match[1]);
      const start = separator + 4;
      const end = start + length;
      if (this.buffer.length < end) return;
      const payload = this.buffer.subarray(start, end).toString("utf8");
      this.buffer = this.buffer.subarray(end);
      void this.handle(JSON.parse(payload) as JsonRpcRequest);
    }
  }

  private async handle(request: JsonRpcRequest): Promise<void> {
    if (request.id === undefined) return;
    try {
      this.send({
        jsonrpc: "2.0",
        id: request.id,
        result: await this.dispatch(request),
      });
    } catch (error) {
      this.send({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : "Team Memory MCP error",
        },
      });
    }
  }

  private async dispatch(request: JsonRpcRequest): Promise<unknown> {
    switch (request.method) {
      case "initialize":
        return {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "team-memory-rbac", version: "0.1.0" },
        };
      case "tools/list": {
        const tools = await this.client.listTools() as Array<{
          name: string;
          description?: string;
          inputSchema?: unknown;
        }>;
        return {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? "Team Memory tool",
            inputSchema: tool.inputSchema ?? {
              type: "object",
              additionalProperties: true,
            },
          })),
        };
      }
      case "tools/call": {
        const name = request.params?.name;
        if (typeof name !== "string" || name.length === 0) {
          throw new Error("tools/call requires params.name");
        }
        return textContent(await this.client.callTool(name, toolInput(request.params)));
      }
      case "ping":
        return {};
      default:
        throw new Error(`unsupported MCP method: ${request.method}`);
    }
  }

  private send(response: JsonRpcResponse): void {
    const body = JSON.stringify(response);
    this.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }
}

export function createTeamMemoryMcpStdioServerFromEnv(
  environment: Record<string, string | undefined>,
): TeamMemoryMcpStdioServer {
  const baseUrl = environment.TEAM_MEMORY_URL;
  const token = environment.TEAM_MEMORY_TOKEN;
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error("TEAM_MEMORY_URL must be configured");
  }
  if (token === undefined || token.length === 0) {
    throw new Error("TEAM_MEMORY_TOKEN must be configured");
  }
  return new TeamMemoryMcpStdioServer(
    new TeamMemoryHttpClient({ baseUrl, token }),
  );
}
