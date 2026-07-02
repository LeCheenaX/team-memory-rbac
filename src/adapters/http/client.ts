export interface TeamMemoryHttpClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export interface TeamMemoryHttpErrorPayload {
  error: {
    code: string;
    message: string;
    decision?: unknown;
  };
}

export class TeamMemoryHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly decision?: unknown;

  constructor(status: number, payload: TeamMemoryHttpErrorPayload) {
    super(`${payload.error.code}: ${payload.error.message}`);
    this.status = status;
    this.code = payload.error.code;
    if (payload.error.decision !== undefined) this.decision = payload.error.decision;
  }
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function query(input: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized.length === 0 ? "" : `?${serialized}`;
}

/** Production HTTP client used by host integrations. */
export class TeamMemoryHttpClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TeamMemoryHttpClientOptions) {
    this.baseUrl = withTrailingSlash(options.baseUrl);
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  identity(): Promise<unknown> {
    return this.request("GET", "identity");
  }

  listTools(): Promise<unknown> {
    return this.request("GET", "agent/tools");
  }

  search(input: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "memory/search", input, false);
  }

  write(input: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "memory/write", input);
  }

  importResource(input: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "resources/import", input);
  }

  readResource(resourceId: string, revisionId?: string): Promise<unknown> {
    return this.request(
      "GET",
      `resources/${encodeURIComponent(resourceId)}${query({ revisionId })}`,
      undefined,
      false,
    );
  }

  history(input: Record<string, unknown> = {}): Promise<unknown> {
    return this.request("GET", `history${query(input)}`);
  }

  conflicts(input: Record<string, unknown> = {}): Promise<unknown> {
    return this.request("GET", `conflicts${query(input)}`);
  }

  resolveConflict(input: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "conflicts/resolve", input);
  }

  syncPull(input: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "sync/pull", input, false);
  }

  async callTool(toolName: string, input: Record<string, unknown>): Promise<unknown> {
    switch (toolName) {
      case "memory.importResource":
        return this.importResource(input);
      case "memory.readResource": {
        const resourceId = this.requiredString(input, "resourceId");
        return this.readResource(
          resourceId,
          typeof input.revisionId === "string" ? input.revisionId : undefined,
        );
      }
      case "memory.write":
        return this.write(input);
      case "memory.search":
        return this.search(input);
      case "memory.history":
        return this.history(input);
      case "memory.conflicts":
        return this.conflicts(input);
      case "memory.resolveConflict":
        return this.resolveConflict(input);
      case "memory.syncPull":
        return this.syncPull(input);
      default:
        throw new Error(`unknown Team Memory tool: ${toolName}`);
    }
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    payload?: Record<string, unknown>,
    unwrapValue = true,
  ): Promise<unknown> {
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    };
    const response = await this.fetchImpl(new URL(path, this.baseUrl), init);
    const text = await response.text();
    const parsed = text.length === 0 ? {} : JSON.parse(text) as Record<string, unknown>;
    if (!response.ok) {
      throw new TeamMemoryHttpError(
        response.status,
        parsed as unknown as TeamMemoryHttpErrorPayload,
      );
    }
    if (unwrapValue && "value" in parsed) return parsed.value;
    return parsed;
  }

  private requiredString(input: Record<string, unknown>, key: string): string {
    const value = input[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${key} is required`);
    }
    return value;
  }
}
