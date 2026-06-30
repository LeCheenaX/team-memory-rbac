import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  InMemoryLocalAuthorizedWorkingReplica,
  type AuthorizedViewDelta,
  type AuthorizedViewIdentity,
  type CloudCommitRecord,
  type LocalAuthorizedWorkingReplica,
  type LocalAuthorizedWorkingReplicaState,
  type MemoryActiveView,
} from "../../index.ts";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function readState(path: string): LocalAuthorizedWorkingReplicaState | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as LocalAuthorizedWorkingReplicaState;
}

export class FileSystemLocalAuthorizedWorkingReplica
  implements LocalAuthorizedWorkingReplica
{
  private readonly statePath: string;
  private readonly temporaryPath: string;
  private readonly delegate: InMemoryLocalAuthorizedWorkingReplica;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.statePath = join(directory, "state.json");
    this.temporaryPath = join(directory, "state.json.tmp");
    this.delegate = new InMemoryLocalAuthorizedWorkingReplica(
      readState(this.statePath),
    );
  }

  inspect(): LocalAuthorizedWorkingReplicaState {
    return this.delegate.inspect();
  }

  replace(
    identity: AuthorizedViewIdentity,
    snapshot: MemoryActiveView,
  ): void {
    this.delegate.replace(identity, snapshot);
    this.persist();
  }

  applyDelta(
    identity: AuthorizedViewIdentity,
    delta: AuthorizedViewDelta,
  ): void {
    this.delegate.applyDelta(identity, delta);
    this.persist();
  }

  advance(identity: AuthorizedViewIdentity): void {
    this.delegate.advance(identity);
    this.persist();
  }

  replaceHistory(records: CloudCommitRecord[]): void {
    this.delegate.replaceHistory(records);
    this.persist();
  }

  applyHistory(records: CloudCommitRecord[]): void {
    this.delegate.applyHistory(records);
    this.persist();
  }

  replacePendingOperations(operations: unknown[]): void {
    this.delegate.replacePendingOperations(operations);
    this.persist();
  }

  invalidate(): void {
    this.delegate.invalidate();
    this.persist();
  }

  clear(): void {
    this.delegate.clear();
    this.persist();
  }

  readView(rootEntityId: string, branchRef: string): MemoryActiveView {
    return this.delegate.readView(rootEntityId, branchRef);
  }

  storageManifest(): ReturnType<
    InMemoryLocalAuthorizedWorkingReplica["storageManifest"]
  > {
    return this.delegate.storageManifest();
  }

  private persist(): void {
    writeFileSync(
      this.temporaryPath,
      `${JSON.stringify(clone(this.delegate.inspect()), null, 2)}\n`,
      "utf8",
    );
    renameSync(this.temporaryPath, this.statePath);
  }
}
