import type { MemoryOperation } from "../contracts/history.ts";
import type {
  MemoryEntity,
  MemoryEntityBranch,
  ResourceChunk,
} from "../contracts/memory.ts";
import type { HistoryAuthority } from "../history/authority.ts";
import type { Bm25Document, Bm25Index } from "../ingestion/bm25.ts";
import {
  DeterministicEmbeddingProvider,
  type EmbeddingProvider,
} from "../ingestion/service.ts";
import type { MemoryProjectionWrite, MemoryProjector } from "./projector.ts";
import type { VectorMemoryPoint } from "./stores.ts";

export interface HistoryMemoryProjectionResult {
  projectedSequences: number[];
  lastSequence: number;
}

export class HistoryMemoryProjectionWorker {
  private readonly history: Pick<HistoryAuthority, "replay">;
  private readonly projector: MemoryProjector;
  private readonly embeddings: EmbeddingProvider;
  private readonly bm25: Bm25Index | undefined;
  private readonly watermarks = new Map<string, number>();

  constructor(
    history: Pick<HistoryAuthority, "replay">,
    projector: MemoryProjector,
    options: {
      embeddings?: EmbeddingProvider;
      bm25?: Bm25Index;
    } = {},
  ) {
    this.history = history;
    this.projector = projector;
    this.embeddings = options.embeddings ?? new DeterministicEmbeddingProvider();
    this.bm25 = options.bm25;
  }

  async project(
    rootEntityId: string,
    branchRef: string,
    afterSequence = this.watermarks.get(watermarkKey(rootEntityId, branchRef)) ?? 0,
  ): Promise<HistoryMemoryProjectionResult> {
    const events = await this.history.replay({
      rootEntityId,
      branchRef,
      afterSequence,
    });
    const projectedSequences: number[] = [];
    let lastSequence = afterSequence;
    for (const event of events) {
      await this.projectOperations(event.operations);
      projectedSequences.push(event.sequence);
      lastSequence = Math.max(lastSequence, event.sequence);
    }
    this.watermarks.set(watermarkKey(rootEntityId, branchRef), lastSequence);
    return { projectedSequences, lastSequence };
  }

  private async projectOperations(operations: MemoryOperation[]): Promise<void> {
    for (const operation of operations) {
      const write = await this.writeForOperation(operation);
      if (write !== undefined) {
        await this.projector.project(write);
      }
      const documents = this.bm25DocumentsForOperation(operation);
      if (documents.length > 0) {
        await this.bm25?.upsertDocuments(documents);
      }
    }
  }

  private async writeForOperation(
    operation: MemoryOperation,
  ): Promise<MemoryProjectionWrite | undefined> {
    switch (operation.input.kind) {
      case "create_entity":
        return {
          vectorPoints: [await this.entityPoint(operation.input.entity)],
        };
      case "create_entity_branch":
        return {
          vectorPoints: [await this.entityBranchPoint(operation.input.branch)],
        };
      case "create_relation":
        return { relations: [operation.input.relation] };
      case "create_resource_chunk":
        return {
          vectorPoints: [
            await this.resourceChunkPoint(operation.input.chunk, operation),
          ],
        };
      case "replace_relation":
        return {
          relations: [operation.input.replacement],
          tombstoneRelationIds: [
            {
              id: operation.input.previousRelationId,
              updatedAt: operation.createdAt,
            },
          ],
        };
      case "tombstone_relation":
        return {
          tombstoneRelationIds: [
            { id: operation.input.targetId, updatedAt: operation.createdAt },
          ],
        };
      case "tombstone_entity":
        return {
          removeVectorPoints: [
            { collection: "memory_entities", id: operation.input.targetId },
          ],
          removeVectorPointsByFilter: [
            {
              collection: "memory_entity_branches",
              filter: {
                rootEntityId: operation.rootEntityId,
                branchRef: operation.branchRef,
                entityId: operation.input.targetId,
              },
            },
          ],
        };
      case "tombstone_entity_branch":
        return {
          removeVectorPoints: [
            {
              collection: "memory_entity_branches",
              id: operation.input.targetId,
            },
          ],
        };
      case "tombstone_resource":
        return {
          removeVectorPointsByFilter: [
            {
              collection: "resource_chunks",
              filter: {
                rootEntityId: operation.rootEntityId,
                branchRef: operation.branchRef,
                resourceId: operation.input.targetId,
              },
            },
          ],
        };
      case "create_resource":
      case "revise_resource":
      case "revert_commit":
      case "resolve_conflict":
        return undefined;
    }
  }

  private async entityPoint(entity: MemoryEntity): Promise<VectorMemoryPoint> {
    return {
      collection: "memory_entities",
      id: entity.id,
      vector: await this.embeddings.embed(
        [entity.id, entity.currentBranchId ?? "", entity.status].join("\n"),
      ),
      payload: {
        ...entity,
        memoryId: entity.id,
        collection: "memory_entities",
        entityId: entity.id,
        status: entity.status,
        origin: "cloud_snapshot",
      },
    };
  }

  private async entityBranchPoint(
    branch: MemoryEntityBranch,
  ): Promise<VectorMemoryPoint> {
    const description =
      typeof branch.description === "string" ? branch.description : "";
    const tags = Array.isArray(branch.tags) ? branch.tags : [];
    return {
      collection: "memory_entity_branches",
      id: branch.id,
      vector: await this.embeddings.embed(
        [branch.title, description, ...tags].join("\n"),
      ),
      payload: {
        ...branch,
        description,
        tags,
        importance:
          typeof branch.importance === "number" ? branch.importance : 0,
        confidence:
          typeof branch.confidence === "number" ? branch.confidence : 0,
        memoryId: branch.id,
        collection: "memory_entity_branches",
        entityBranchId: branch.id,
        status: branch.status,
        origin: branch.origin ?? "cloud_snapshot",
        pendingId: branch.pendingId ?? null,
      },
    };
  }

  private async resourceChunkPoint(
    chunk: ResourceChunk,
    operation: MemoryOperation,
  ): Promise<VectorMemoryPoint> {
    return {
      collection: "resource_chunks",
      id: chunk.id,
      vector: await this.embeddings.embed(chunk.text),
      payload: {
        ...chunk,
        memoryId: chunk.id,
        collection: "resource_chunks",
        chunkId: chunk.id,
        branchRef: operation.branchRef,
        status: chunk.status ?? "active",
        origin: chunk.origin ?? "cloud_snapshot",
        pendingId: chunk.pendingId ?? null,
      },
    };
  }

  private bm25DocumentsForOperation(
    operation: MemoryOperation,
  ): Bm25Document[] {
    if (operation.input.kind !== "create_resource_chunk") {
      return [];
    }
    const chunk = operation.input.chunk;
    return [
      {
        id: chunk.bm25DocumentId ?? `bm25:${chunk.id}`,
        rootEntityId: operation.rootEntityId,
        branchRef: operation.branchRef,
        resourceId: chunk.resourceId,
        revisionId:
          typeof chunk.metadata?.revisionId === "string"
            ? chunk.metadata.revisionId
            : operation.commitId,
        chunkId: chunk.id,
        text: chunk.text,
        status: chunk.status ?? "active",
      },
    ];
  }
}

function watermarkKey(rootEntityId: string, branchRef: string): string {
  return `${rootEntityId}\0${branchRef}`;
}
