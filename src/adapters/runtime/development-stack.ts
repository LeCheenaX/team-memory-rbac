import type { Client } from "@libsql/client";
import { FileSystemResourceCas } from "../cas/filesystem.ts";
import { ObjectStoreResourceCas } from "../cas/object-store.ts";
import { createLibsqlClient } from "../libsql/client.ts";
import { LibsqlHistoryAuthority } from "../libsql/history-authority.ts";
import { LibsqlRbacAuthority, type CreatedSession } from "../libsql/rbac-authority.ts";
import { PersistentRbacAdminService } from "../libsql/admin-service.ts";
import { LibsqlBm25Index } from "../libsql/bm25-index.ts";
import { LibsqlMemoryRelationStore } from "../libsql/relation-store.ts";
import { QdrantVectorMemoryStore } from "../qdrant/vector-memory-store.ts";
import { ScopedPolicyEngine } from "../../rbac/policy-engine.ts";
import { BUILT_IN_ROLES } from "../../rbac/catalog.ts";
import { ResourceService } from "../../resources/service.ts";
import type { AuthenticatedSession } from "../libsql/rbac-authority.ts";
import {
  MemoryRetrievalAdapter,
  type MemoryRetrievalRequest,
  type MemoryRetrievalResult,
  StoreBackedAuthorizedQuerySource,
} from "../../memory/retrieval.ts";
import { PermissionRouter } from "../../permission-router.ts";
import { ResourceIngestionService } from "../../ingestion/service.ts";
import type { ResourceCas } from "../../memory/stores.ts";
import { StoreMemoryProjector } from "../../memory/projector.ts";
import { HistoryMemoryProjectionWorker } from "../../memory/projection-worker.ts";

export type CasBackendKind = "filesystem" | "object_store";

export interface RuntimeConfig {
  libsqlUrl: string;
  libsqlAuthToken?: string;
  casBackend?: CasBackendKind;
  casDirectory?: string;
  qdrantUrl: string;
  objectStoreUrl?: string;
  qdrantApiKey?: string;
}

export function loadRuntimeConfig(environment: Record<string, string | undefined>): RuntimeConfig {
  const required = (name: string): string => {
    const value = environment[name];
    if (value === undefined || value.length === 0) throw new Error(`${name} must be configured explicitly`);
    return value;
  };
  const authToken = environment.LIBSQL_AUTH_TOKEN;
  const casBackend = required("CAS_BACKEND");
  if (casBackend !== "filesystem" && casBackend !== "object_store") {
    throw new Error("CAS_BACKEND must be filesystem or object_store");
  }
  return {
    libsqlUrl: required("LIBSQL_URL"),
    ...(authToken === undefined || authToken.length === 0 ? {} : { libsqlAuthToken: authToken }),
    casBackend,
    ...(casBackend === "filesystem" ? { casDirectory: required("CAS_DIRECTORY") } : {}),
    qdrantUrl: required("QDRANT_URL"),
    ...(casBackend === "object_store" ? { objectStoreUrl: required("OBJECT_STORE_URL") } : {}),
    ...(environment.QDRANT_API_KEY === undefined ||
    environment.QDRANT_API_KEY.length === 0
      ? {}
      : { qdrantApiKey: environment.QDRANT_API_KEY }),
  };
}

function createResourceCas(config: RuntimeConfig): ResourceCas {
  const backend = config.casBackend ?? "filesystem";
  if (backend === "object_store") {
    if (config.objectStoreUrl === undefined) throw new Error("OBJECT_STORE_URL must be configured for object_store CAS");
    return new ObjectStoreResourceCas(config.objectStoreUrl);
  }
  if (config.casDirectory === undefined) throw new Error("CAS_DIRECTORY must be configured for filesystem CAS");
  return new FileSystemResourceCas(config.casDirectory);
}

async function readyCas(cas: ResourceCas): Promise<void> {
  if ("ready" in cas && typeof cas.ready === "function") {
    await cas.ready();
  }
}

export class TeamMemoryRuntime {
  readonly client: Client;
  readonly rbac: LibsqlRbacAuthority;
  readonly history: LibsqlHistoryAuthority;
  readonly policy: ScopedPolicyEngine;
  readonly cas: ResourceCas;
  readonly resources: ResourceService;
  readonly admin: PersistentRbacAdminService;
  readonly vectors: QdrantVectorMemoryStore;
  readonly relations: LibsqlMemoryRelationStore;
  readonly bm25: LibsqlBm25Index;
  readonly ingestion: ResourceIngestionService;
  readonly projection: HistoryMemoryProjectionWorker;
  readonly retrieval: PermissionRouter<
    MemoryRetrievalResult,
    MemoryRetrievalRequest
  >;
  private readonly config: RuntimeConfig;

  private constructor(
    client: Client,
    rbac: LibsqlRbacAuthority,
    history: LibsqlHistoryAuthority,
    policy: ScopedPolicyEngine,
    cas: ResourceCas,
    resources: ResourceService,
    admin: PersistentRbacAdminService,
    vectors: QdrantVectorMemoryStore,
    relations: LibsqlMemoryRelationStore,
    bm25: LibsqlBm25Index,
    ingestion: ResourceIngestionService,
    projection: HistoryMemoryProjectionWorker,
    retrieval: TeamMemoryRuntime["retrieval"],
    config: RuntimeConfig,
  ) { this.client = client; this.rbac = rbac; this.history = history; this.policy = policy; this.cas = cas; this.resources = resources; this.admin = admin; this.vectors = vectors; this.relations = relations; this.bm25 = bm25; this.ingestion = ingestion; this.projection = projection; this.retrieval = retrieval; this.config = config; }

  static async create(config: RuntimeConfig): Promise<TeamMemoryRuntime> {
    const client = createLibsqlClient({ url: config.libsqlUrl, ...(config.libsqlAuthToken === undefined ? {} : { authToken: config.libsqlAuthToken }) });
    const rbac = await LibsqlRbacAuthority.create(client);
    const history = await LibsqlHistoryAuthority.create(client);
    const policy = new ScopedPolicyEngine(rbac);
    const cas = createResourceCas(config);
    await readyCas(cas);
    const resources = new ResourceService(policy, history, cas);
    const admin = new PersistentRbacAdminService(rbac, policy);
    const vectors = new QdrantVectorMemoryStore({ url: config.qdrantUrl, ...(config.qdrantApiKey === undefined ? {} : { apiKey: config.qdrantApiKey }) });
    const relations = await LibsqlMemoryRelationStore.create(client);
    const bm25 = await LibsqlBm25Index.create(client);
    const ingestion = new ResourceIngestionService(policy, history, cas, vectors, bm25);
    const projection = new HistoryMemoryProjectionWorker(
      history,
      new StoreMemoryProjector(cas, vectors, relations),
      { bm25 },
    );
    const retrieval = new PermissionRouter(policy, new MemoryRetrievalAdapter(new StoreBackedAuthorizedQuerySource(vectors, relations, "cloud_active", bm25)));
    return new TeamMemoryRuntime(client, rbac, history, policy, cas, resources, admin, vectors, relations, bm25, ingestion, projection, retrieval, config);
  }

  async projectMemory(rootEntityId: string, branchRef: string): Promise<void> {
    await this.projection.project(rootEntityId, branchRef);
  }

  async ready(): Promise<void> {
    await this.client.execute("select 1");
    await readyCas(this.cas);
    const checks = [
      fetch(new URL("/healthz", this.config.qdrantUrl)).then((response) => { if (!response.ok) throw new Error(`Qdrant is not ready (${response.status})`); }),
    ];
    if ((this.config.casBackend ?? "filesystem") === "object_store") {
      if (this.config.objectStoreUrl === undefined) throw new Error("OBJECT_STORE_URL must be configured for object_store CAS");
      checks.push(fetch(new URL("/minio/health/live", this.config.objectStoreUrl)).then((response) => { if (!response.ok) throw new Error(`object store is not ready (${response.status})`); }));
    }
    await Promise.all(checks);
  }

  /** Create a new RootEntity from an existing human administrator session. */
  async createRootEntity(session: AuthenticatedSession, input: { rootEntityId: string; clientMutationId: string; createdAt?: string }): Promise<void> {
    if (session.subject.kind !== "user") throw new Error("agents cannot create RootEntity records");
    const decision = await this.policy.decide({ subject: session.subject, rootEntityId: session.rootEntityId, action: "create_root_entity", resourceKind: "memory_entity" });
    if (!decision.allowed) throw new Error(`administrator permission required: ${decision.reason}`);
    const createdAt = input.createdAt ?? new Date().toISOString();
    // The permission is evaluated against the administrator's current root,
    // then bound to the newly created root only for the History write.
    await this.history.execute({
      subject: session.subject,
      rootEntityId: input.rootEntityId,
      branchRef: "main",
      action: "create_root_entity",
      resourceKind: "memory_entity",
      clientMutationId: input.clientMutationId,
      commit: { id: `commit:${input.clientMutationId}`, message: "Create RootEntity" },
      operation: { kind: "create_entity", id: `operation:${input.clientMutationId}`, entity: { id: input.rootEntityId, rootEntityId: null, status: "active", createdAt, updatedAt: createdAt } },
      authorization: { ...decision, allowed: true, rootEntityId: input.rootEntityId },
    });
    await this.rbac.saveAssignment({ id: `root-owner:${session.userId}:${input.rootEntityId}`, userId: session.userId, rootEntityId: input.rootEntityId, roleId: "role-root-admin", assignedBy: session.userId, assignedAt: createdAt, status: "active" });
    await this.rbac.appendAudit({ id: `audit:root-create:${input.clientMutationId}`, rootEntityId: input.rootEntityId, actorUserId: session.userId, action: "create_root_entity", payload: { sourceRootEntityId: session.rootEntityId }, createdAt });
  }

  close(): void { this.client.close(); }
}

export interface DevelopmentBootstrapInput {
  rootEntityId: string;
  userId: string;
  displayName: string;
  sessionId: string;
  sessionExpiresAt: string;
  now: string;
}

/** Explicit, local-only bootstrap used by the development init command. */
export async function bootstrapDevelopment(runtime: TeamMemoryRuntime, input: DevelopmentBootstrapInput): Promise<CreatedSession> {
  for (const role of BUILT_IN_ROLES) await runtime.rbac.saveRole(role);
  await runtime.rbac.saveUser({ id: input.userId, displayName: input.displayName, status: "active", createdAt: input.now, updatedAt: input.now });
  if (runtime.history.readActiveView(input.rootEntityId, "main").entities.length === 0) {
    await runtime.history.execute({
      subject: { kind: "user", userId: input.userId },
      rootEntityId: input.rootEntityId,
      branchRef: "main",
      action: "create_root_entity",
      resourceKind: "memory_entity",
      clientMutationId: `bootstrap-root:${input.rootEntityId}`,
      commit: { id: `bootstrap-root-commit:${input.rootEntityId}`, message: "Create development root" },
      operation: { kind: "create_entity", id: `bootstrap-root-operation:${input.rootEntityId}`, entity: { id: input.rootEntityId, rootEntityId: null, status: "active", createdAt: input.now, updatedAt: input.now } },
      authorization: { allowed: true, reason: "development_bootstrap", subjectId: input.userId, subjectKind: "user", rootEntityId: input.rootEntityId, action: "create_root_entity", resourceKind: "memory_entity", matchedRoles: [], missingActions: [], constraints: { allowRootEntityMutation: true } },
    });
  }
  await runtime.rbac.saveAssignment({ id: `bootstrap-assignment:${input.userId}:${input.rootEntityId}`, userId: input.userId, rootEntityId: input.rootEntityId, roleId: "role-root-admin", assignedBy: input.userId, assignedAt: input.now, status: "active" });
  return runtime.rbac.createSession({ id: input.sessionId, userId: input.userId, rootEntityId: input.rootEntityId, taskScope: { rootEntityId: input.rootEntityId }, expiresAt: input.sessionExpiresAt, createdAt: input.now });
}
