import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { TeamMemoryRuntime } from "../runtime/development-stack.ts";
import {
  gatewayErrorFromUnknown,
  TeamMemoryGateway,
  type TeamMemoryGatewayError,
} from "../runtime/gateway.ts";

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length === 0 ? {} : JSON.parse(raw) as Record<string, unknown>;
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function sendValue(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, { value });
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

function statusFor(error: TeamMemoryGatewayError): number {
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

export function createTeamMemoryServer(runtimeOrGateway: TeamMemoryRuntime | TeamMemoryGateway): Server {
  const gateway = runtimeOrGateway instanceof TeamMemoryGateway
    ? runtimeOrGateway
    : new TeamMemoryGateway(runtimeOrGateway);
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/live") return send(response, 200, { status: "ok" });
      if (request.method === "GET" && url.pathname === "/ready") {
        if (runtimeOrGateway instanceof TeamMemoryRuntime) await runtimeOrGateway.ready();
        return send(response, 200, { status: "ready" });
      }
      const bearer = token(request);
      if (request.method === "GET" && url.pathname === "/identity") {
        return sendValue(response, 200, await gateway.identity(bearer));
      }
      if (request.method === "GET" && url.pathname === "/agent/tools") {
        return sendValue(response, 200, await gateway.listAgentTools(bearer));
      }
      if (request.method === "GET" && url.pathname === "/admin/roots") {
        return sendValue(response, 200, await gateway.listRoots(bearer));
      }
      if (request.method === "POST" && url.pathname === "/admin/roots") {
        const payload = await body(request);
        const normalized: Record<string, unknown> = {
          ...payload,
          newRootEntityId: typeof payload.newRootEntityId === "string"
            ? payload.newRootEntityId
            : stringValue(payload, "rootEntityId"),
        };
        delete normalized.rootEntityId;
        return sendValue(response, 201, await gateway.createRoot(bearer, normalized));
      }
      if (request.method === "GET" && url.pathname === "/admin/members") {
        return sendValue(response, 200, await gateway.listMembers(bearer));
      }
      if (request.method === "POST" && url.pathname === "/admin/members/roles") {
        return sendValue(response, 201, await gateway.assignRole(bearer, await body(request)));
      }
      if (request.method === "POST" && url.pathname === "/admin/members/roles/revoke") {
        return sendValue(response, 200, await gateway.revokeRole(bearer, await body(request)));
      }
      if (request.method === "GET" && url.pathname === "/admin/delegations") {
        return sendValue(response, 200, await gateway.listDelegations(bearer));
      }
      if (request.method === "POST" && url.pathname === "/admin/delegations") {
        return sendValue(response, 201, await gateway.createDelegation(bearer, await body(request)));
      }
      if (request.method === "POST" && url.pathname === "/admin/delegations/revoke") {
        return sendValue(response, 200, await gateway.revokeDelegation(bearer, await body(request)));
      }
      if (request.method === "POST" && url.pathname === "/admin/agents/onboard") {
        return sendValue(response, 201, await gateway.onboardAgent(bearer, await body(request)));
      }
      if (request.method === "POST" && url.pathname === "/resources/import") {
        return sendValue(response, 201, await gateway.importResource(bearer, await body(request)));
      }
      const revisionMatch = /^\/resources\/([^/]+)\/revisions$/.exec(url.pathname);
      if (request.method === "POST" && revisionMatch?.[1] !== undefined) {
        return sendValue(response, 201, await gateway.reviseResource(bearer, decodeURIComponent(revisionMatch[1]), await body(request)));
      }
      const resourceMatch = /^\/resources\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && resourceMatch?.[1] !== undefined) {
        return send(response, 200, await gateway.readResource(bearer, decodeURIComponent(resourceMatch[1]), url.searchParams.get("revisionId") ?? undefined));
      }
      if (request.method === "POST" && url.pathname === "/memory/write") {
        return sendValue(response, 200, await gateway.writeMemory(bearer, await body(request)));
      }
      if (request.method === "POST" && url.pathname === "/memory/search") {
        return send(response, 200, await gateway.searchMemory(bearer, await body(request)));
      }
      if (request.method === "GET" && url.pathname === "/history") {
        return sendValue(response, 200, await gateway.listHistory(bearer, queryPayload(url)));
      }
      if (request.method === "GET" && url.pathname === "/conflicts") {
        return sendValue(response, 200, await gateway.listConflicts(bearer, queryPayload(url)));
      }
      if (request.method === "POST" && url.pathname === "/conflicts/resolve") {
        return sendValue(response, 200, await gateway.resolveConflict(bearer, await body(request)));
      }
      if (request.method === "POST" && url.pathname === "/sync/pull") {
        return send(response, 200, await gateway.pullSync(bearer, await body(request)));
      }
      if (request.method === "GET" && url.pathname === "/sync/status") {
        return sendValue(response, 200, await gateway.syncStatus(bearer));
      }
      return send(response, 404, { error: "not_found" });
    } catch (error) {
      const gatewayError = gatewayErrorFromUnknown(error);
      return send(response, statusFor(gatewayError), {
        error: {
          code: gatewayError.code,
          message: gatewayError.message.replace(`${gatewayError.code}: `, ""),
          ...(gatewayError.decision === undefined
            ? {}
            : { decision: gatewayError.decision }),
        },
      });
    }
  });
}
