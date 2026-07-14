import type { Client } from "@libsql/client";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
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
import {
  DeterministicEmbeddingProvider,
  HttpEmbeddingProvider,
  ResourceIngestionService,
  type EmbeddingProvider,
} from "../../ingestion/service.ts";
import type { ResourceCas } from "../../memory/stores.ts";
import { StoreMemoryProjector } from "../../memory/projector.ts";
import { HistoryMemoryProjectionWorker } from "../../memory/projection-worker.ts";

export type CasBackendKind = "filesystem" | "object_store";
export type RuntimeMode = "unitTest" | "Dev" | "Production";
export type EmbeddingProviderKind = "deterministic" | "http";

export interface RuntimeConfigDocument {
  runtimeMode: RuntimeMode;
  libsql: {
    url: string;
    authToken?: string;
  };
  cas: {
    backend: CasBackendKind;
    directory?: string;
    objectStoreUrl?: string;
  };
  qdrant: {
    url: string;
    apiKey?: string;
  };
  embedding: {
    provider: EmbeddingProviderKind;
    url: string;
    apiKey?: string;
    model?: string;
    name?: string;
    dimensions?: number;
  };
  retrieval?: {
    recallTopP?: number;
  };
  activation?: {
    status: "active";
    embedding: {
      provider: EmbeddingProviderKind;
      url: string;
      model?: string;
      name?: string;
    };
    validatedAt: string;
  };
}

export interface RuntimeConfig {
  libsqlUrl: string;
  libsqlAuthToken?: string;
  runtimeMode: RuntimeMode;
  casBackend: CasBackendKind;
  casDirectory?: string;
  qdrantUrl: string;
  objectStoreUrl?: string;
  qdrantApiKey?: string;
  embeddings: EmbeddingProvider;
  embeddingProviderUrl: string;
  embeddingProviderKind: EmbeddingProviderKind;
  embeddingProviderModel?: string;
  embeddingProviderName?: string;
  recallTopP: number;
  activation?: RuntimeConfigDocument["activation"];
}

export async function loadRuntimeConfigFile(path: string): Promise<RuntimeConfig> {
  const raw = await readFile(path, "utf8");
  return loadRuntimeConfig(JSON.parse(raw) as RuntimeConfigDocument);
}

export function loadRuntimeConfig(document: RuntimeConfigDocument): RuntimeConfig {
  const runtimeMode = runtimeModeFrom(document.runtimeMode);
  const casBackend = casBackendFrom(document.cas?.backend);
  const embeddings = embeddingsFromDocument(document.embedding, runtimeMode);
  return {
    libsqlUrl: requiredString(document.libsql?.url, "libsql.url"),
    ...(optionalString(document.libsql?.authToken) === undefined ? {} : { libsqlAuthToken: document.libsql.authToken }),
    runtimeMode,
    casBackend,
    ...(casBackend === "filesystem" ? { casDirectory: requiredString(document.cas.directory, "cas.directory") } : {}),
    qdrantUrl: requiredString(document.qdrant?.url, "qdrant.url"),
    ...(casBackend === "object_store" ? { objectStoreUrl: requiredString(document.cas.objectStoreUrl, "cas.objectStoreUrl") } : {}),
    ...(optionalString(document.qdrant?.apiKey) === undefined ? {} : { qdrantApiKey: document.qdrant.apiKey }),
    embeddings,
    embeddingProviderUrl: requiredString(document.embedding?.url, "embedding.url"),
    embeddingProviderKind: document.embedding.provider,
    ...(optionalString(document.embedding.model) === undefined ? {} : { embeddingProviderModel: document.embedding.model }),
    ...(optionalString(document.embedding.name) === undefined ? {} : { embeddingProviderName: document.embedding.name }),
    recallTopP: recallTopPFrom(document.retrieval?.recallTopP),
    ...(document.activation === undefined ? {} : { activation: document.activation }),
  };
}

function runtimeModeFrom(value: string | undefined): RuntimeMode {
  if (value === "unitTest" || value === "Dev" || value === "Production") {
    return value;
  }
  throw new Error("runtimeMode must be unitTest, Dev, or Production");
}

function casBackendFrom(value: string | undefined): CasBackendKind {
  if (value === "filesystem" || value === "object_store") return value;
  throw new Error("cas.backend must be filesystem or object_store");
}

function requiredString(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be configured explicitly`);
  }
  return value;
}

function optionalString(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

function recallTopPFrom(value: number | undefined): number {
  const recallTopP = value ?? 0.8;
  if (!Number.isFinite(recallTopP) || recallTopP <= 0 || recallTopP > 1) {
    throw new Error("retrieval.recallTopP must be greater than 0 and less than or equal to 1");
  }
  return recallTopP;
}

function embeddingsFromDocument(
  embedding: RuntimeConfigDocument["embedding"] | undefined,
  runtimeMode: RuntimeMode,
): EmbeddingProvider {
  if (embedding === undefined) {
    throw new Error("embedding configuration must be provided before using memory");
  }
  const provider = requiredString(embedding.provider, "embedding.provider");
  const url = requiredString(embedding.url, "embedding.url");
  if (provider === "deterministic") {
    if (runtimeMode !== "unitTest") {
      throw new Error("deterministic embeddings are only allowed in unitTest");
    }
    return new DeterministicEmbeddingProvider(embedding.dimensions);
  }
  if (provider === "http") {
    return new HttpEmbeddingProvider({
      url,
      ...(optionalString(embedding.apiKey) === undefined ? {} : { apiKey: embedding.apiKey }),
      ...(optionalString(embedding.model) === undefined ? {} : { model: embedding.model }),
      ...(optionalString(embedding.name) === undefined ? {} : { name: embedding.name }),
    });
  }
  throw new Error("embedding.provider must be deterministic or http");
}

function createResourceCas(config: RuntimeConfig): ResourceCas {
  const backend = config.casBackend ?? "filesystem";
  if (backend === "object_store") {
    if (config.objectStoreUrl === undefined) throw new Error("cas.objectStoreUrl must be configured for object_store CAS");
    return new ObjectStoreResourceCas(config.objectStoreUrl);
  }
  if (config.casDirectory === undefined) throw new Error("cas.directory must be configured for filesystem CAS");
  return new FileSystemResourceCas(config.casDirectory);
}

async function readyCas(cas: ResourceCas): Promise<void> {
  if ("ready" in cas && typeof cas.ready === "function") {
    await cas.ready();
  }
}

async function readyLibsqlFileDirectory(url: string): Promise<void> {
  if (!url.startsWith("file:")) return;
  const path = url.slice("file:".length);
  if (path.length === 0 || path.startsWith("//")) return;
  await mkdir(dirname(path), { recursive: true });
}

function runtimeMode(config: RuntimeConfig): RuntimeMode {
  return config.runtimeMode;
}

function configuredEmbeddings(config: RuntimeConfig): EmbeddingProvider {
  if (config.embeddings === undefined) {
    throw new Error("embedding provider must be configured before using memory");
  }
  return config.embeddings;
}

function assertRuntimeEmbeddings(
  config: RuntimeConfig,
  embeddings: EmbeddingProvider,
): void {
  if (
    runtimeMode(config) !== "unitTest" &&
    embeddings.productionSafe !== true
  ) {
    throw new Error("Dev and Production require a real embedding provider");
  }
}

function assertMemoryActivated(config: RuntimeConfig): void {
  if (runtimeMode(config) === "unitTest") return;
  const activation = config.activation;
  if (activation?.status !== "active") {
    throw new Error("memory module is not active. Run `team-memory setup --config <path>` and complete embedding validation first.");
  }
  if (
    activation.embedding.provider !== config.embeddingProviderKind ||
    activation.embedding.url !== config.embeddingProviderUrl ||
    activation.embedding.model !== config.embeddingProviderModel ||
    activation.embedding.name !== config.embeddingProviderName
  ) {
    throw new Error("memory module setup is stale. Re-run `team-memory setup --config <path>` after changing embedding configuration.");
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
  readonly embeddings: EmbeddingProvider;

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
    embeddings: EmbeddingProvider,
  ) { this.client = client; this.rbac = rbac; this.history = history; this.policy = policy; this.cas = cas; this.resources = resources; this.admin = admin; this.vectors = vectors; this.relations = relations; this.bm25 = bm25; this.ingestion = ingestion; this.projection = projection; this.retrieval = retrieval; this.config = config; this.embeddings = embeddings; }

  static async create(config: RuntimeConfig): Promise<TeamMemoryRuntime> {
    const embeddings = configuredEmbeddings(config);
    assertRuntimeEmbeddings(config, embeddings);
    assertMemoryActivated(config);
    await embeddings.ready?.();
    await readyLibsqlFileDirectory(config.libsqlUrl);
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
    const ingestion = new ResourceIngestionService(policy, history, cas, vectors, bm25, embeddings);
    const projection = new HistoryMemoryProjectionWorker(
      history,
      new StoreMemoryProjector(cas, vectors, relations),
      { bm25, embeddings },
    );
    const retrieval = new PermissionRouter(policy, new MemoryRetrievalAdapter(new StoreBackedAuthorizedQuerySource(vectors, relations, "cloud_active", bm25), { embeddings, recallTopP: config.recallTopP }));
    return new TeamMemoryRuntime(client, rbac, history, policy, cas, resources, admin, vectors, relations, bm25, ingestion, projection, retrieval, config, embeddings);
  }

  async projectMemory(rootEntityId: string, branchRef: string): Promise<void> {
    await this.projection.project(rootEntityId, branchRef);
  }

  get recallTopP(): number {
    return this.config.recallTopP;
  }

  async ready(): Promise<void> {
    assertRuntimeEmbeddings(this.config, this.embeddings);
    assertMemoryActivated(this.config);
    await this.client.execute("select 1");
    await readyCas(this.cas);
    await this.embeddings.ready?.();
    const checks = [
      fetch(new URL("/healthz", this.config.qdrantUrl)).then((response) => { if (!response.ok) throw new Error(`Qdrant is not ready (${response.status})`); }),
    ];
    if ((this.config.casBackend ?? "filesystem") === "object_store") {
      if (this.config.objectStoreUrl === undefined) throw new Error("cas.objectStoreUrl must be configured for object_store CAS");
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
