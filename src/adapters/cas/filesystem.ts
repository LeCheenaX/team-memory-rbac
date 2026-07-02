import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ResourceCas, ResourceCasObject } from "../../memory/stores.ts";

function digest(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function pathFor(rootDirectory: string, contentHash: string): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(contentHash);
  if (match?.[1] === undefined) throw new Error("contentHash must be a sha256 digest");
  return join(rootDirectory, "sha256", match[1].slice(0, 2), match[1]);
}

/**
 * Immutable filesystem CAS.
 *
 * Production use is limited to a single service worker or multiple workers
 * sharing the same durable volume. Workers with independent filesystems must
 * use the object-store CAS backend instead.
 */
export class FileSystemResourceCas implements ResourceCas {
  private readonly rootDirectory: string;

  constructor(rootDirectory: string) { this.rootDirectory = rootDirectory; }

  async put(object: ResourceCasObject): Promise<void> {
    if (digest(object.content) !== object.contentHash) throw new Error("CAS content hash does not match bytes");
    const destination = pathFor(this.rootDirectory, object.contentHash);
    try { await stat(destination); return; } catch { /* object is new */ }
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, object.content);
    try { await rename(temporary, destination); } catch (error) {
      try { await stat(destination); } catch { throw error; }
      await unlink(temporary).catch(() => undefined);
    }
  }

  async get(contentHash: string): Promise<ResourceCasObject | undefined> {
    try { return { contentHash, content: await readFile(pathFor(this.rootDirectory, contentHash)) }; }
    catch { return undefined; }
  }

  async remove(_contentHash: string): Promise<void> {
    throw new Error("CAS objects are immutable and are not physically removed by the application");
  }

  async ready(): Promise<void> { await mkdir(this.rootDirectory, { recursive: true }); }
}

export function contentHash(content: string | Uint8Array): string { return digest(content); }
