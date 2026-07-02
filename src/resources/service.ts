import { randomUUID } from "node:crypto";
import type { CloudMemoryAuthority, CloudMemoryWriteCommand } from "../history/cloud-authority.ts";
import type { MemoryOperationInput } from "../contracts/history.ts";
import type { Resource, ResourceSourceType } from "../contracts/memory.ts";
import type { PolicyEngine } from "../contracts/rbac.ts";
import type { AuthenticatedSession } from "../adapters/libsql/rbac-authority.ts";
import type { ResourceCas } from "../memory/stores.ts";
import { contentHash } from "../adapters/cas/filesystem.ts";

export class ResourceNotFoundError extends Error {
  constructor() { super("resource not found"); }
}

export interface ResourceImportInput {
  clientMutationId: string;
  resourceId?: string;
  revisionId?: string;
  commitId?: string;
  branchRef?: string;
  title: string;
  sourceType: ResourceSourceType;
  content: string | Uint8Array;
  uri?: string;
  metadata?: Record<string, unknown>;
  expectedHeadCommitId?: string;
}

export interface ResourceRevisionInput {
  clientMutationId: string;
  resourceId: string;
  revisionId?: string;
  commitId?: string;
  branchRef?: string;
  content: string | Uint8Array;
  metadata?: Record<string, unknown>;
  expectedHeadCommitId?: string;
}

export interface ResourceReadInput { resourceId: string; revisionId?: string; branchRef?: string; }

type ResourceHistory = Pick<CloudMemoryAuthority, "execute" | "listCommitRecords" | "readActiveView" | "headCommitId">;

function timestamp(): string { return new Date().toISOString(); }

/**
 * Authenticated L1 import/read path. It deliberately takes a trusted server
 * session instead of accepting a client-supplied subject, root, or TaskScope.
 */
export class ResourceService {
  private readonly policy: PolicyEngine;
  private readonly history: ResourceHistory;
  private readonly cas: ResourceCas;
  private readonly now: () => string;

  constructor(
    policy: PolicyEngine,
    history: ResourceHistory,
    cas: ResourceCas,
    now: () => string = timestamp,
  ) { this.policy = policy; this.history = history; this.cas = cas; this.now = now; }

  async import(session: AuthenticatedSession, input: ResourceImportInput): Promise<{ resource: Resource; contentHash: string }> {
    const rootEntityId = session.rootEntityId;
    const branchRef = input.branchRef ?? "main";
    const hash = contentHash(input.content);
    await this.putAndVerify(hash, input.content);
    const createdAt = this.now();
    const resourceId = input.resourceId ?? `resource:${randomUUID()}`;
    const revisionId = input.revisionId ?? `revision:${randomUUID()}`;
    const operation: MemoryOperationInput = {
      kind: "create_resource",
      id: `operation:${input.commitId ?? input.clientMutationId}`,
      revisionId,
      resource: {
        id: resourceId,
        rootEntityId,
        sourceType: input.sourceType,
        title: input.title,
        ...(input.uri === undefined ? {} : { uri: input.uri }),
        contentHash: hash,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        createdAt,
        updatedAt: createdAt,
      },
    };
    await this.write(session, {
      clientMutationId: input.clientMutationId,
      branchRef,
      ...(input.expectedHeadCommitId === undefined ? {} : { expectedHeadCommitId: input.expectedHeadCommitId }),
      commit: { id: input.commitId ?? `commit:${input.clientMutationId}`, message: "Import resource" },
      action: "import_resource",
      resourceKind: "resource",
      operation,
    });
    return { resource: operation.resource, contentHash: hash };
  }

  async revise(session: AuthenticatedSession, input: ResourceRevisionInput): Promise<{ revisionId: string; contentHash: string }> {
    const branchRef = input.branchRef ?? "main";
    const resource = this.history.readActiveView(session.rootEntityId, branchRef).resources.find((candidate) => candidate.id === input.resourceId);
    if (resource === undefined) throw new ResourceNotFoundError();
    await this.require(session, "import_resource", "resource", input.resourceId);
    const hash = contentHash(input.content);
    await this.putAndVerify(hash, input.content);
    const revisionId = input.revisionId ?? `revision:${randomUUID()}`;
    await this.write(session, {
      clientMutationId: input.clientMutationId,
      branchRef,
      ...(input.expectedHeadCommitId === undefined
        ? this.expectedHead(session.rootEntityId, branchRef)
        : { expectedHeadCommitId: input.expectedHeadCommitId }),
      commit: { id: input.commitId ?? `commit:${input.clientMutationId}`, message: "Revise resource" },
      action: "import_resource",
      resourceKind: "resource",
      operation: { kind: "revise_resource", id: `operation:${input.commitId ?? input.clientMutationId}`, resourceId: input.resourceId, revisionId, contentHash: hash, ...(input.metadata === undefined ? {} : { metadata: input.metadata }) },
    });
    return { revisionId, contentHash: hash };
  }

  async read(session: AuthenticatedSession, input: ResourceReadInput): Promise<{ resource: Resource; revisionId: string; content: string | Uint8Array }> {
    const branchRef = input.branchRef ?? "main";
    const resource = this.history.readActiveView(session.rootEntityId, branchRef).resources.find((candidate) => candidate.id === input.resourceId);
    if (resource === undefined) throw new ResourceNotFoundError();
    const decision = await this.policy.decide({ subject: session.subject, rootEntityId: session.rootEntityId, action: "read", resourceKind: "resource", resourceId: input.resourceId, taskScope: session.taskScope });
    if (!decision.allowed) throw new ResourceNotFoundError();
    const revision = this.findRevision(session.rootEntityId, branchRef, input.resourceId, input.revisionId);
    if (revision === undefined) throw new ResourceNotFoundError();
    const object = await this.cas.get(revision.contentHash);
    if (object === undefined || object.contentHash !== revision.contentHash) throw new Error("CAS object is unavailable or inconsistent");
    return { resource, revisionId: revision.id, content: object.content };
  }

  async tombstone(session: AuthenticatedSession, input: { clientMutationId: string; resourceId: string; commitId?: string; branchRef?: string }): Promise<void> {
    const branchRef = input.branchRef ?? "main";
    await this.write(session, {
      clientMutationId: input.clientMutationId,
      branchRef,
      ...this.expectedHead(session.rootEntityId, branchRef),
      commit: { id: input.commitId ?? `commit:${input.clientMutationId}`, message: "Tombstone resource" },
      action: "tombstone_resource",
      resourceKind: "resource",
      resourceId: input.resourceId,
      operation: { kind: "tombstone_resource", id: `operation:${input.commitId ?? input.clientMutationId}`, targetId: input.resourceId },
    });
  }

  private async write(session: AuthenticatedSession, command: Omit<CloudMemoryWriteCommand, "subject" | "rootEntityId" | "taskScope">): Promise<void> {
    const decision = await this.policy.decide({ ...command, subject: session.subject, rootEntityId: session.rootEntityId, taskScope: session.taskScope });
    if (!decision.allowed) throw new Error(`permission denied: ${decision.reason}`);
    await this.history.execute({ ...command, subject: session.subject, rootEntityId: session.rootEntityId, taskScope: session.taskScope, authorization: decision as typeof decision & { allowed: true } });
  }

  private async require(session: AuthenticatedSession, action: "import_resource", resourceKind: "resource", resourceId: string): Promise<void> {
    const decision = await this.policy.decide({ subject: session.subject, rootEntityId: session.rootEntityId, action, resourceKind, resourceId, taskScope: session.taskScope });
    if (!decision.allowed) throw new ResourceNotFoundError();
  }

  private async putAndVerify(hash: string, content: string | Uint8Array): Promise<void> {
    await this.cas.put({ contentHash: hash, content });
    const object = await this.cas.get(hash);
    if (object === undefined || object.contentHash !== hash || contentHash(object.content) !== hash) {
      throw new Error("CAS object is not durably readable after write");
    }
  }

  private findRevision(rootEntityId: string, branchRef: string, resourceId: string, requestedRevisionId?: string): { id: string; contentHash: string } | undefined {
    const revisions = this.history.listCommitRecords(rootEntityId, branchRef)
      .filter((record) => record.status === "accepted")
      .flatMap((record) => record.operations)
      .flatMap((operation) => {
        const input = operation.input;
        if (input.kind === "create_resource" && input.resource.id === resourceId) return [{ id: input.revisionId, contentHash: input.resource.contentHash }];
        if (input.kind === "revise_resource" && input.resourceId === resourceId) return [{ id: input.revisionId, contentHash: input.contentHash }];
        return [];
      });
    if (requestedRevisionId !== undefined) return revisions.find((revision) => revision.id === requestedRevisionId);
    return revisions.at(-1);
  }

  private expectedHead(rootEntityId: string, branchRef: string): { expectedHeadCommitId?: string } {
    const head = this.history.headCommitId(rootEntityId, branchRef);
    return head === undefined ? {} : { expectedHeadCommitId: head };
  }
}
