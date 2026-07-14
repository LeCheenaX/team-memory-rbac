import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { TeamMemoryRuntime } from "../runtime/development-stack.ts";
import {
  gatewayErrorFromUnknown,
  TeamMemoryGateway,
  TeamMemoryGatewayError,
} from "../runtime/gateway.ts";
import {
  FixedWindowRateLimiter,
  StructuredOperationalLogger,
  withTimeout,
} from "../runtime/operations.ts";

export interface TeamMemoryHttpServerOptions {
  requestBodyLimitBytes?: number;
  requestTimeoutMs?: number;
  rateLimit?: {
    maxRequests: number;
    windowMs: number;
  };
  logger?: StructuredOperationalLogger;
  traceId?: () => string;
}

interface GatewayLike {
  identity(token: string | undefined): Promise<unknown>;
  listAgentTools(token: string | undefined): Promise<unknown>;
  listRoots(token: string | undefined): Promise<unknown>;
  createRoot(token: string | undefined, payload: Record<string, unknown>): Promise<unknown>;
  listMembers(token: string | undefined): Promise<unknown>;
  assignRole(token: string | undefined, payload: Record<string, unknown>): Promise<unknown>;
  revokeRole(token: string | undefined, payload: Record<string, unknown>): Promise<unknown>;
  listDelegations(token: string | undefined): Promise<unknown>;
  createDelegation(token: string | undefined, payload: Record<string, unknown>): Promise<unknown>;
  revokeDelegation(token: string | undefined, payload: Record<string, unknown>): Promise<unknown>;
  onboardAgent(token: string | undefined, payload: Record<string, unknown>): Promise<unknown>;
  migrateLegacyHostCaptures(token: string | undefined, payload: Record<string, unknown>): Promise<unknown>;
  importResource(token: string | undefined, payload: Record<string, unknown>): Promise<unknown>;
  reviseResource(token: string | undefined, resourceId: string, payload: Record<string, unknown>): Promise<unknown>;
  ingestResource(token: string | undefined, resourceId: string, payload: Record<string, unknown>): Promise<unknown>;
  readResource(token: string | undefined, resourceId: string, revisionId?: string): Promise<unknown>;
  memoryCatalog(token: string | undefined, payload: Record<string, unknown>): Promise<unknown>;
  writeMemory(token: string | undefined, payload: Record<string, unknown>): Promise<unknown>;
  searchMemory(token: string | undefined, payload: Record<string, unknown>): Promise<unknown>;
  recallHostMemory(token: string | undefined, payload: Record<string, unknown>): Promise<unknown>;
  captureHostMemory(token: string | undefined, payload: Record<string, unknown>): Promise<unknown>;
  listHistory(token: string | undefined, payload: Record<string, unknown>): Promise<unknown>;
  listConflicts(token: string | undefined, payload: Record<string, unknown>): Promise<unknown>;
  resolveConflict(token: string | undefined, payload: Record<string, unknown>): Promise<unknown>;
  pullSync(token: string | undefined, payload: Record<string, unknown>): Promise<unknown>;
  syncStatus(token: string | undefined): Promise<unknown>;
}

class HttpGuardrailError extends Error {
  readonly code:
    | "request_too_large"
    | "request_timeout"
    | "rate_limited";

  constructor(
    code: HttpGuardrailError["code"],
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

const defaultBodyLimitBytes = 1024 * 1024;
const defaultTimeoutMs = 30_000;
const defaultRateLimit = { maxRequests: 120, windowMs: 60_000 };

async function body(
  request: IncomingMessage,
  limitBytes: number,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const declaredLength = request.headers["content-length"];
  if (
    typeof declaredLength === "string" &&
    Number.parseInt(declaredLength, 10) > limitBytes
  ) {
    throw new HttpGuardrailError(
      "request_too_large",
      `request body exceeds ${limitBytes} bytes`,
    );
  }
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > limitBytes) {
      throw new HttpGuardrailError(
        "request_too_large",
        `request body exceeds ${limitBytes} bytes`,
      );
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length === 0 ? {} : JSON.parse(raw) as Record<string, unknown>;
}

function send(
  response: ServerResponse,
  status: number,
  payload: unknown,
  traceId?: string,
): void {
  if (response.writableEnded) return;
  if (traceId !== undefined) response.setHeader("x-trace-id", traceId);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function responseValue(status: number, value: unknown): RouteResponse {
  return { status, payload: { value } };
}

function token(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
}

function stringValue(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
  return value;
}

function statusFor(error: TeamMemoryGatewayError | HttpGuardrailError): number {
  if (error instanceof HttpGuardrailError) {
    if (error.code === "request_too_large") return 413;
    if (error.code === "request_timeout") return 504;
    if (error.code === "rate_limited") return 429;
  }
  if (error.code === "auth_failed") return 401;
  if (error.code === "permission_denied") return 403;
  if (error.code === "conflict") return 409;
  if (error.code === "not_found") return 404;
  if (error.code === "dependency_unavailable") return 503;
  return 400;
}

function queryPayload(url: URL): Record<string, unknown> {
  return Object.fromEntries(
    [...url.searchParams.entries()].map(([key, value]) => [
      key,
      key === "afterSequence" || key === "knownCommitWatermark"
        ? Number(value)
        : value,
    ]),
  );
}

interface RouteResponse {
  status: number;
  payload: unknown;
}

function gatewayFor(runtimeOrGateway: TeamMemoryRuntime | TeamMemoryGateway | GatewayLike): GatewayLike {
  if (runtimeOrGateway instanceof TeamMemoryRuntime) {
    return new TeamMemoryGateway(runtimeOrGateway);
  }
  return runtimeOrGateway;
}

function rateLimitKey(request: IncomingMessage): string {
  const bearer = token(request);
  return bearer === undefined
    ? `ip:${request.socket.remoteAddress ?? "unknown"}`
    : `token:${bearer}`;
}

function redactMessage(value: string): string {
  return value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]");
}

function normalizeError(error: unknown): TeamMemoryGatewayError | HttpGuardrailError {
  if (error instanceof HttpGuardrailError) return error;
  const gatewayError = gatewayErrorFromUnknown(error);
  return new TeamMemoryGatewayError(
    gatewayError.code,
    redactMessage(gatewayError.message.replace(`${gatewayError.code}: `, "")),
    gatewayError.decision,
  );
}

function errorPayload(error: TeamMemoryGatewayError | HttpGuardrailError): unknown {
  return {
    error: {
      code: error.code,
      message: error.message.replace(`${error.code}: `, ""),
      ...("decision" in error && error.decision === undefined
        ? {}
        : "decision" in error ? { decision: error.decision } : {}),
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  runtimeOrGateway: TeamMemoryRuntime | TeamMemoryGateway | GatewayLike,
  gateway: GatewayLike,
  bodyLimitBytes: number,
): Promise<RouteResponse> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/live") return { status: 200, payload: { status: "ok" } };
  if (request.method === "GET" && url.pathname === "/ready") {
    if (runtimeOrGateway instanceof TeamMemoryRuntime) await runtimeOrGateway.ready();
    return { status: 200, payload: { status: "ready" } };
  }
  const bearer = token(request);
  if (request.method === "GET" && url.pathname === "/identity") {
    return responseValue(200, await gateway.identity(bearer));
  }
  if (request.method === "GET" && url.pathname === "/agent/tools") {
    return responseValue(200, await gateway.listAgentTools(bearer));
  }
  if (request.method === "GET" && url.pathname === "/admin/roots") {
    return responseValue(200, await gateway.listRoots(bearer));
  }
  if (request.method === "POST" && url.pathname === "/admin/roots") {
    const payload = await body(request, bodyLimitBytes);
    const normalized: Record<string, unknown> = {
      ...payload,
      newRootEntityId: typeof payload.newRootEntityId === "string"
        ? payload.newRootEntityId
        : stringValue(payload, "rootEntityId"),
    };
    delete normalized.rootEntityId;
    return responseValue(201, await gateway.createRoot(bearer, normalized));
  }
  if (request.method === "GET" && url.pathname === "/admin/members") {
    return responseValue(200, await gateway.listMembers(bearer));
  }
  if (request.method === "POST" && url.pathname === "/admin/members/roles") {
    return responseValue(201, await gateway.assignRole(bearer, await body(request, bodyLimitBytes)));
  }
  if (request.method === "POST" && url.pathname === "/admin/members/roles/revoke") {
    return responseValue(200, await gateway.revokeRole(bearer, await body(request, bodyLimitBytes)));
  }
  if (request.method === "GET" && url.pathname === "/admin/delegations") {
    return responseValue(200, await gateway.listDelegations(bearer));
  }
  if (request.method === "POST" && url.pathname === "/admin/delegations") {
    return responseValue(201, await gateway.createDelegation(bearer, await body(request, bodyLimitBytes)));
  }
  if (request.method === "POST" && url.pathname === "/admin/delegations/revoke") {
    return responseValue(200, await gateway.revokeDelegation(bearer, await body(request, bodyLimitBytes)));
  }
  if (request.method === "POST" && url.pathname === "/admin/agents/onboard") {
    return responseValue(201, await gateway.onboardAgent(bearer, await body(request, bodyLimitBytes)));
  }
  if (request.method === "POST" && url.pathname === "/admin/migrations/legacy-host-captures") {
    return responseValue(200, await gateway.migrateLegacyHostCaptures(bearer, await body(request, bodyLimitBytes)));
  }
  if (request.method === "POST" && url.pathname === "/resources/import") {
    return responseValue(201, await gateway.importResource(bearer, await body(request, bodyLimitBytes)));
  }
  const revisionMatch = /^\/resources\/([^/]+)\/revisions$/.exec(url.pathname);
  if (request.method === "POST" && revisionMatch?.[1] !== undefined) {
    return responseValue(201, await gateway.reviseResource(bearer, decodeURIComponent(revisionMatch[1]), await body(request, bodyLimitBytes)));
  }
  const ingestMatch = /^\/resources\/([^/]+)\/ingest$/.exec(url.pathname);
  if (request.method === "POST" && ingestMatch?.[1] !== undefined) {
    return responseValue(200, await gateway.ingestResource(bearer, decodeURIComponent(ingestMatch[1]), await body(request, bodyLimitBytes)));
  }
  const resourceMatch = /^\/resources\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && resourceMatch?.[1] !== undefined) {
    return { status: 200, payload: await gateway.readResource(bearer, decodeURIComponent(resourceMatch[1]), url.searchParams.get("revisionId") ?? undefined) };
  }
  if (request.method === "POST" && url.pathname === "/memory/write") {
    return responseValue(200, await gateway.writeMemory(bearer, await body(request, bodyLimitBytes)));
  }
  if (request.method === "POST" && url.pathname === "/memory/search") {
    return { status: 200, payload: await gateway.searchMemory(bearer, await body(request, bodyLimitBytes)) };
  }
  if (request.method === "GET" && url.pathname === "/memory/catalog") {
    return responseValue(200, await gateway.memoryCatalog(bearer, queryPayload(url)));
  }
  const hostRecallMatch = /^\/host\/([^/]+)\/recall$/.exec(url.pathname);
  if (request.method === "POST" && hostRecallMatch?.[1] !== undefined) {
    const payload = await body(request, bodyLimitBytes);
    return responseValue(200, await gateway.recallHostMemory(bearer, {
      ...payload,
      host: decodeURIComponent(hostRecallMatch[1]),
    }));
  }
  const hostCaptureMatch = /^\/host\/([^/]+)\/capture$/.exec(url.pathname);
  if (request.method === "POST" && hostCaptureMatch?.[1] !== undefined) {
    const payload = await body(request, bodyLimitBytes);
    return responseValue(200, await gateway.captureHostMemory(bearer, {
      ...payload,
      host: decodeURIComponent(hostCaptureMatch[1]),
    }));
  }
  if (request.method === "GET" && url.pathname === "/history") {
    return responseValue(200, await gateway.listHistory(bearer, queryPayload(url)));
  }
  if (request.method === "GET" && url.pathname === "/conflicts") {
    return responseValue(200, await gateway.listConflicts(bearer, queryPayload(url)));
  }
  if (request.method === "POST" && url.pathname === "/conflicts/resolve") {
    return responseValue(200, await gateway.resolveConflict(bearer, await body(request, bodyLimitBytes)));
  }
  if (request.method === "POST" && url.pathname === "/sync/pull") {
    return { status: 200, payload: await gateway.pullSync(bearer, await body(request, bodyLimitBytes)) };
  }
  if (request.method === "GET" && url.pathname === "/sync/status") {
    return responseValue(200, await gateway.syncStatus(bearer));
  }
  return { status: 404, payload: { error: "not_found" } };
}

export function createTeamMemoryServer(
  runtimeOrGateway: TeamMemoryRuntime | TeamMemoryGateway | GatewayLike,
  options: TeamMemoryHttpServerOptions = {},
): Server {
  const gateway = gatewayFor(runtimeOrGateway);
  const bodyLimitBytes = options.requestBodyLimitBytes ?? defaultBodyLimitBytes;
  const timeoutMs = options.requestTimeoutMs ?? defaultTimeoutMs;
  const rateLimit = options.rateLimit ?? defaultRateLimit;
  const limiter = new FixedWindowRateLimiter(rateLimit.maxRequests, rateLimit.windowMs);
  const logger = options.logger ?? new StructuredOperationalLogger(() => undefined);
  const traceIdFactory = options.traceId ?? randomUUID;

  return createServer(async (request, response) => {
    const startedAt = performance.now();
    const traceId = request.headers["x-trace-id"]?.toString() ?? traceIdFactory();
    const auditId = request.headers["x-audit-id"]?.toString();
    const url = new URL(request.url ?? "/", "http://localhost");
    let status = 500;
    try {
      if (url.pathname !== "/live" && url.pathname !== "/ready") {
        const limited = limiter.check(rateLimitKey(request));
        if (!limited.allowed) {
          if (limited.retryAfterMs !== undefined) {
            response.setHeader("retry-after", Math.ceil(limited.retryAfterMs / 1000));
          }
          throw new HttpGuardrailError("rate_limited", "rate limit exceeded");
        }
      }
      const result = await withTimeout(
        handleRequest(request, runtimeOrGateway, gateway, bodyLimitBytes),
        timeoutMs,
        "request timed out",
      ).catch((error) => {
        if (error instanceof Error && error.message === "request timed out") {
          throw new HttpGuardrailError("request_timeout", error.message);
        }
        throw error;
      });
      status = result.status;
      send(response, result.status, result.payload, traceId);
    } catch (error) {
      const normalized = normalizeError(error);
      status = statusFor(normalized);
      send(response, status, errorPayload(normalized), traceId);
      logger.emit({
        level: status >= 500 ? "error" : "warn",
        event: "http.request",
        traceId,
        ...(auditId === undefined ? {} : { auditId }),
        metrics: { durationMs: performance.now() - startedAt },
        details: {
          method: request.method,
          route: url.pathname,
          status,
          error: {
            code: normalized.code,
            message: normalized.message,
          },
          headers: {
            authorization: request.headers.authorization,
          },
        },
      });
      return;
    }
    logger.emit({
      level: "info",
      event: "http.request",
      traceId,
      ...(auditId === undefined ? {} : { auditId }),
      metrics: { durationMs: performance.now() - startedAt },
      details: {
        method: request.method,
        route: url.pathname,
        status,
      },
    });
  });
}
