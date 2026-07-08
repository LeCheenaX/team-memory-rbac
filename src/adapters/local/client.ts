import type { TeamMemoryGateway } from "../runtime/gateway.ts";

function unwrapValue(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    "value" in value &&
    Object.keys(value).length === 1
  ) {
    return (value as { value: unknown }).value;
  }
  return value;
}

/**
 * Local in-process client for host adapters.
 *
 * This has the same shape as the HTTP client used by production connectors,
 * but calls a local TeamMemoryGateway directly. It is intended for offline
 * host operation and manual no-server tests; sync remains a server/cloud
 * concern and is deliberately not promoted to a second authority here.
 */
export class LocalTeamMemoryClient {
  private readonly gateway: TeamMemoryGateway;
  private readonly token: string;

  constructor(gateway: TeamMemoryGateway, token: string) {
    this.gateway = gateway;
    this.token = token;
  }

  identity(): Promise<unknown> {
    return this.gateway.identity(this.token);
  }

  listTools(): Promise<unknown> {
    return this.gateway.listAgentTools(this.token);
  }

  search(input: Record<string, unknown>): Promise<unknown> {
    return this.gateway.searchMemory(this.token, input);
  }

  catalog(input: Record<string, unknown> = {}): Promise<unknown> {
    return this.gateway.memoryCatalog(this.token, input);
  }

  recallHostMemory(host: string, input: Record<string, unknown>): Promise<unknown> {
    return this.gateway.recallHostMemory(this.token, { ...input, host });
  }

  captureHostMemory(host: string, input: Record<string, unknown>): Promise<unknown> {
    return this.gateway.captureHostMemory(this.token, { ...input, host });
  }

  write(input: Record<string, unknown>): Promise<unknown> {
    return this.gateway.writeMemory(this.token, input);
  }

  importResource(input: Record<string, unknown>): Promise<unknown> {
    return this.gateway.importResource(this.token, input);
  }

  ingestResource(resourceId: string, input: Record<string, unknown>): Promise<unknown> {
    return this.gateway.ingestResource(this.token, resourceId, input);
  }

  readResource(resourceId: string, revisionId?: string): Promise<unknown> {
    return this.gateway.readResource(this.token, resourceId, revisionId);
  }

  history(input: Record<string, unknown> = {}): Promise<unknown> {
    return this.gateway.listHistory(this.token, input);
  }

  conflicts(input: Record<string, unknown> = {}): Promise<unknown> {
    return this.gateway.listConflicts(this.token, input);
  }

  resolveConflict(input: Record<string, unknown>): Promise<unknown> {
    return this.gateway.resolveConflict(this.token, input);
  }

  syncPull(input: Record<string, unknown>): Promise<unknown> {
    return this.gateway.pullSync(this.token, input);
  }

  async callTool(toolName: string, input: Record<string, unknown>): Promise<unknown> {
    switch (toolName) {
      case "memory.importResource":
        return this.importResource(input);
      case "memory.ingestResource":
        return this.ingestResource(this.requiredString(input, "resourceId"), input);
      case "memory.readResource":
        return this.readResource(
          this.requiredString(input, "resourceId"),
          typeof input.revisionId === "string" ? input.revisionId : undefined,
        );
      case "memory.catalog":
        return this.catalog(input);
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

  async callHermesTool(toolName: string, input: Record<string, unknown>): Promise<unknown> {
    return unwrapValue(await this.callTool(toolName, input));
  }

  private requiredString(input: Record<string, unknown>, key: string): string {
    const value = input[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${key} is required`);
    }
    return value;
  }
}
