import { randomUUID } from "node:crypto";
import type {
  CloudMemoryAuthority,
  CloudMemoryWriteCommand,
} from "../history/cloud-authority.ts";
import type { MemoryOperationInput } from "../contracts/history.ts";
import type {
  Resource,
  ResourceChunk,
  ResourceSourceType,
} from "../contracts/memory.ts";
import type { PolicyEngine } from "../contracts/rbac.ts";
import type { AuthenticatedSession } from "../adapters/libsql/rbac-authority.ts";
import { contentHash } from "../adapters/cas/filesystem.ts";
import type { ResourceCas, VectorMemoryPoint, VectorMemoryStore } from "../memory/stores.ts";
import type { Bm25Document, Bm25Index } from "./bm25.ts";

export interface EmbeddingProvider {
  readonly name?: string;
  readonly productionSafe?: boolean;
  ready?(): Promise<void>;
  embed(text: string): Promise<number[]>;
}

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly name = "deterministic-local-v1";
  readonly productionSafe = false;

  private readonly dimensions: number;

  constructor(dimensions = 16) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const vector = Array.from({ length: this.dimensions }, () => 0);
    for (const [index, char] of [...text].entries()) {
      const bucket = index % this.dimensions;
      vector[bucket] = (vector[bucket] ?? 0) + (char.codePointAt(0) ?? 0);
    }
    const magnitude = Math.hypot(...vector) || 1;
    return vector.map((value) => value / magnitude);
  }
}

export class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly productionSafe = true;
  readonly name: string;

  private readonly url: string;
  private readonly apiKey: string | undefined;
  private readonly model: string | undefined;

  constructor(options: {
    url: string;
    apiKey?: string;
    model?: string;
    name?: string;
  }) {
    this.url = options.url;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.name = options.name ?? options.model ?? "http-embedding-provider";
  }

  async ready(): Promise<void> {
    const probe = await this.embed("team memory readiness probe");
    if (probe.length === 0) {
      throw new Error("embedding provider returned an empty vector");
    }
  }

  async embed(text: string): Promise<number[]> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.apiKey !== undefined) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    const response = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        input: text,
        ...(this.model === undefined ? {} : { model: this.model }),
      }),
    });
    if (!response.ok) {
      throw new Error(`embedding provider failed (${response.status})`);
    }
    const payload = await response.json() as {
      embedding?: unknown;
      data?: Array<{ embedding?: unknown }>;
    };
    const embedding = Array.isArray(payload.embedding)
      ? payload.embedding
      : payload.data?.[0]?.embedding;
    if (
      !Array.isArray(embedding) ||
      embedding.some((value) => typeof value !== "number")
    ) {
      throw new Error("embedding provider returned an invalid vector");
    }
    return embedding;
  }
}

export function embeddingProviderName(provider: EmbeddingProvider): string {
  return provider.name ?? "configured-embedding-provider";
}

export interface IngestResourceRevisionInput {
  resourceId: string;
  revisionId?: string;
  branchRef?: string;
  clientMutationId: string;
  maxChunkCharacters?: number;
}

export interface IngestResourceRevisionResult {
  resource: Resource;
  revisionId: string;
  chunks: ResourceChunk[];
  rebuiltOnly: boolean;
}

type IngestionHistory = Pick<
  CloudMemoryAuthority,
  "execute" | "listCommitRecords" | "readActiveView" | "headCommitId"
>;

interface TextChunk {
  text: string;
  metadata: ResourceChunk["metadata"];
}

function asText(content: string | Uint8Array): string {
  return typeof content === "string"
    ? content
    : new TextDecoder().decode(content);
}

function clampChunkSize(value: number | undefined): number {
  return value === undefined ? 1200 : Math.max(1, value);
}

function groupedLines(
  text: string,
  maxCharacters: number,
  metadataFor: (startLine: number, endLine: number) => ResourceChunk["metadata"],
): TextChunk[] {
  const lines = text.split(/\r?\n/);
  const chunks: TextChunk[] = [];
  let buffer: string[] = [];
  let startLine = 1;
  const flush = (endLine: number) => {
    const joined = buffer.join("\n").trim();
    if (joined.length > 0) {
      chunks.push({ text: joined, metadata: metadataFor(startLine, endLine) });
    }
    buffer = [];
    startLine = endLine + 1;
  };
  for (const [index, line] of lines.entries()) {
    const projected = [...buffer, line].join("\n");
    if (projected.length > maxCharacters && buffer.length > 0) {
      flush(index);
    }
    buffer.push(line);
  }
  flush(lines.length);
  return chunks;
}

function paragraphChunks(text: string, maxCharacters: number): TextChunk[] {
  const paragraphs = text.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
  const chunks: TextChunk[] = [];
  let buffer: string[] = [];
  for (const paragraph of paragraphs) {
    const projected = [...buffer, paragraph].join("\n\n");
    if (projected.length > maxCharacters && buffer.length > 0) {
      chunks.push({ text: buffer.join("\n\n"), metadata: { tokenCount: buffer.join(" ").split(/\s+/).length } });
      buffer = [];
    }
    buffer.push(paragraph);
  }
  if (buffer.length > 0) {
    chunks.push({ text: buffer.join("\n\n"), metadata: { tokenCount: buffer.join(" ").split(/\s+/).length } });
  }
  return chunks;
}

function chunksFor(
  sourceType: ResourceSourceType,
  text: string,
  maxCharacters: number,
): TextChunk[] {
  if (sourceType === "code_file") {
    return groupedLines(text, maxCharacters, (startLine, endLine) => ({
      startLine,
      endLine,
    }));
  }
  if (sourceType === "conversation" || sourceType === "tool_output") {
    return groupedLines(text, maxCharacters, (startLine, endLine) => ({
      startLine,
      endLine,
    }));
  }
  return paragraphChunks(text, maxCharacters);
}

function existingRevisionChunks(
  chunks: ResourceChunk[],
  resourceId: string,
  revisionId: string,
): ResourceChunk[] {
  return chunks
    .filter(
      (chunk) =>
        chunk.resourceId === resourceId &&
        chunk.metadata?.revisionId === revisionId &&
        chunk.status !== "tombstoned",
    )
    .sort((left, right) => left.chunkIndex - right.chunkIndex);
}

export class ResourceIngestionService {
  private readonly policy: PolicyEngine;
  private readonly history: IngestionHistory;
  private readonly cas: ResourceCas;
  private readonly vectors: VectorMemoryStore;
  private readonly bm25: Bm25Index;
  private readonly embeddings: EmbeddingProvider;
  private readonly embeddingModel: string;
  private readonly now: () => string;

  constructor(
    policy: PolicyEngine,
    history: IngestionHistory,
    cas: ResourceCas,
    vectors: VectorMemoryStore,
    bm25: Bm25Index,
    embeddings: EmbeddingProvider = new DeterministicEmbeddingProvider(),
    now: () => string = () => new Date().toISOString(),
  ) {
    this.policy = policy;
    this.history = history;
    this.cas = cas;
    this.vectors = vectors;
    this.bm25 = bm25;
    this.embeddings = embeddings;
    this.embeddingModel = embeddingProviderName(embeddings);
    this.now = now;
  }

  async ingest(
    session: AuthenticatedSession,
    input: IngestResourceRevisionInput,
  ): Promise<IngestResourceRevisionResult> {
    const branchRef = input.branchRef ?? "main";
    const resource = this.history
      .readActiveView(session.rootEntityId, branchRef)
      .resources.find((candidate) => candidate.id === input.resourceId);
    if (resource === undefined) {
      throw new Error("resource not found");
    }
    await this.requireIndexPermission(session, branchRef, resource.id);
    const revision = this.findRevision(
      session.rootEntityId,
      branchRef,
      resource.id,
      input.revisionId,
    );
    if (revision === undefined) {
      throw new Error("resource revision not found");
    }
    const object = await this.cas.get(revision.contentHash);
    if (object === undefined || object.contentHash !== revision.contentHash) {
      throw new Error("CAS object is unavailable or inconsistent");
    }

    const textChunks = chunksFor(
      resource.sourceType,
      asText(object.content),
      clampChunkSize(input.maxChunkCharacters),
    );
    const vectors = await Promise.all(
      textChunks.map((chunk) => this.embeddings.embed(chunk.text)),
    );
    const createdAt = this.now();
    const chunks = textChunks.map((chunk, index): ResourceChunk => ({
      id: `chunk:${revision.id}:${index}`,
      rootEntityId: session.rootEntityId,
      resourceId: resource.id,
      chunkIndex: index,
      text: chunk.text,
      bm25DocumentId: `bm25:${revision.id}:${index}`,
      contentHash: contentHash(chunk.text),
      origin: "import",
      status: "active",
      metadata: {
        ...chunk.metadata,
        revisionId: revision.id,
        contentHash: contentHash(chunk.text),
      },
      createdAt,
      updatedAt: createdAt,
    }));

    const existing = existingRevisionChunks(
      this.history.readActiveView(session.rootEntityId, branchRef).resourceChunks,
      resource.id,
      revision.id,
    );
    const rebuiltOnly =
      existing.length === chunks.length &&
      existing.every(
        (chunk, index) => chunk.contentHash === chunks[index]?.contentHash,
      );
    const authoritativeChunks = rebuiltOnly
      ? existing
      : await this.writeChunks(session, {
          branchRef,
          clientMutationId: input.clientMutationId,
          chunks,
        });

    await this.rebuildIndexes({
      rootEntityId: session.rootEntityId,
      branchRef,
      resource,
      revisionId: revision.id,
      chunks: authoritativeChunks,
      vectors,
    });
    return {
      resource,
      revisionId: revision.id,
      chunks: authoritativeChunks,
      rebuiltOnly,
    };
  }

  private async rebuildIndexes(input: {
    rootEntityId: string;
    branchRef: string;
    resource: Resource;
    revisionId: string;
    chunks: ResourceChunk[];
    vectors: number[][];
  }): Promise<void> {
    const points: VectorMemoryPoint[] = input.chunks.map((chunk, index) => ({
      collection: "resource_chunks",
      id: chunk.id,
      vector: input.vectors[index] ?? [],
      payload: {
        ...chunk,
        branchRef: input.branchRef,
        revisionId: input.revisionId,
        embeddingModel: this.embeddingModel,
      },
    }));
    const documents: Bm25Document[] = input.chunks.map((chunk) => ({
      id: chunk.bm25DocumentId ?? `bm25:${input.revisionId}:${chunk.chunkIndex}`,
      rootEntityId: input.rootEntityId,
      branchRef: input.branchRef,
      resourceId: input.resource.id,
      revisionId: input.revisionId,
      chunkId: chunk.id,
      text: chunk.text,
      status: "active",
    }));
    await this.vectors.upsertMany(points);
    await this.bm25.replaceRevision({
      rootEntityId: input.rootEntityId,
      branchRef: input.branchRef,
      resourceId: input.resource.id,
      revisionId: input.revisionId,
      documents,
    });
  }

  private async writeChunks(
    session: AuthenticatedSession,
    input: {
      branchRef: string;
      clientMutationId: string;
      chunks: ResourceChunk[];
    },
  ): Promise<ResourceChunk[]> {
    const written: ResourceChunk[] = [];
    for (const chunk of input.chunks) {
      const command: Omit<CloudMemoryWriteCommand, "subject" | "rootEntityId" | "taskScope"> = {
        branchRef: input.branchRef,
        ...this.expectedHead(session.rootEntityId, input.branchRef),
        clientMutationId: `${input.clientMutationId}:chunk:${chunk.chunkIndex}`,
        commit: {
          id: `commit:${input.clientMutationId}:chunk:${chunk.chunkIndex}:${randomUUID()}`,
          message: "Index resource chunk",
        },
        action: "write_resource_chunk",
        resourceKind: "resource_chunk",
        resourceId: chunk.resourceId,
        operation: {
          kind: "create_resource_chunk",
          id: `operation:${input.clientMutationId}:chunk:${chunk.chunkIndex}`,
          chunk,
        },
      };
      const decision = await this.policy.decide({
        ...command,
        subject: session.subject,
        rootEntityId: session.rootEntityId,
        taskScope: session.taskScope,
      });
      if (!decision.allowed) {
        throw new Error(`permission denied: ${decision.reason}`);
      }
      await this.history.execute({
        ...command,
        subject: session.subject,
        rootEntityId: session.rootEntityId,
        taskScope: session.taskScope,
        authorization: decision as typeof decision & { allowed: true },
      });
      written.push(chunk);
    }
    return written;
  }

  private async requireIndexPermission(
    session: AuthenticatedSession,
    branchRef: string,
    resourceId: string,
  ): Promise<void> {
    const decision = await this.policy.decide({
      subject: session.subject,
      rootEntityId: session.rootEntityId,
      branchRef,
      action: "index_resource",
      resourceKind: "resource",
      resourceId,
      taskScope: session.taskScope,
    });
    if (!decision.allowed) {
      throw new Error(`permission denied: ${decision.reason}`);
    }
  }

  private findRevision(
    rootEntityId: string,
    branchRef: string,
    resourceId: string,
    requestedRevisionId?: string,
  ): { id: string; contentHash: string } | undefined {
    const revisions = this.history
      .listCommitRecords(rootEntityId, branchRef)
      .filter((record) => record.status === "accepted")
      .flatMap((record) => record.operations)
      .flatMap((operation) => {
        const input = operation.input;
        if (
          input.kind === "create_resource" &&
          input.resource.id === resourceId
        ) {
          return [{ id: input.revisionId, contentHash: input.resource.contentHash }];
        }
        if (
          input.kind === "revise_resource" &&
          input.resourceId === resourceId
        ) {
          return [{ id: input.revisionId, contentHash: input.contentHash }];
        }
        return [];
      });
    if (requestedRevisionId !== undefined) {
      return revisions.find((revision) => revision.id === requestedRevisionId);
    }
    return revisions.at(-1);
  }

  private expectedHead(
    rootEntityId: string,
    branchRef: string,
  ): { expectedHeadCommitId?: string } {
    const head = this.history.headCommitId(rootEntityId, branchRef);
    return head === undefined ? {} : { expectedHeadCommitId: head };
  }
}
