import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { TeamMemoryRuntime } from "../runtime/development-stack.ts";
import { ResourceNotFoundError } from "../../src/resources/service.ts";

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

function token(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
}

function stringValue(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
  return value;
}

export function createTeamMemoryServer(runtime: TeamMemoryRuntime): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/live") return send(response, 200, { status: "ok" });
      if (request.method === "GET" && url.pathname === "/ready") {
        await runtime.ready(); return send(response, 200, { status: "ready" });
      }
      const bearer = token(request);
      const session = bearer === undefined ? undefined : await runtime.rbac.authenticate(bearer);
      if (session === undefined) return send(response, 401, { error: "unauthenticated" });
      if (request.method === "POST" && url.pathname === "/admin/roots") {
        const payload = await body(request);
        await runtime.createRootEntity(session, { rootEntityId: stringValue(payload, "rootEntityId"), clientMutationId: stringValue(payload, "clientMutationId") });
        return send(response, 201, { status: "created" });
      }
      if (request.method === "POST" && url.pathname === "/resources/import") {
        const payload = await body(request);
        const content = typeof payload.content === "string" ? payload.content : Buffer.from(stringValue(payload, "contentBase64"), "base64");
        const result = await runtime.resources.import(session, { clientMutationId: stringValue(payload, "clientMutationId"), ...(typeof payload.resourceId === "string" ? { resourceId: payload.resourceId } : {}), title: stringValue(payload, "title"), sourceType: stringValue(payload, "sourceType") as never, content, ...(typeof payload.uri === "string" ? { uri: payload.uri } : {}), ...(typeof payload.metadata === "object" && payload.metadata !== null ? { metadata: payload.metadata as Record<string, unknown> } : {}) });
        return send(response, 201, result);
      }
      const revisionMatch = /^\/resources\/([^/]+)\/revisions$/.exec(url.pathname);
      if (request.method === "POST" && revisionMatch?.[1] !== undefined) {
        const payload = await body(request);
        const content = typeof payload.content === "string" ? payload.content : Buffer.from(stringValue(payload, "contentBase64"), "base64");
        const result = await runtime.resources.revise(session, { clientMutationId: stringValue(payload, "clientMutationId"), resourceId: decodeURIComponent(revisionMatch[1]), content });
        return send(response, 201, result);
      }
      const resourceMatch = /^\/resources\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && resourceMatch?.[1] !== undefined) {
        const result = await runtime.resources.read(session, { resourceId: decodeURIComponent(resourceMatch[1]), ...(url.searchParams.has("revisionId") ? { revisionId: url.searchParams.get("revisionId") as string } : {}) });
        const content = typeof result.content === "string" ? Buffer.from(result.content).toString("base64") : Buffer.from(result.content).toString("base64");
        return send(response, 200, { resource: result.resource, revisionId: result.revisionId, contentBase64: content });
      }
      return send(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) return send(response, 404, { error: "not_found" });
      return send(response, 400, { error: error instanceof Error ? error.message : "invalid_request" });
    }
  });
}
