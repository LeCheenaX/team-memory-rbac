import { createHash } from "node:crypto";
import type { ResourceCas, ResourceCasObject } from "../../memory/stores.ts";

function digest(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function objectPath(contentHash: string): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(contentHash);
  if (match?.[1] === undefined) throw new Error("contentHash must be a sha256 digest");
  return `/cas/sha256/${match[1]}`;
}

function objectUrl(baseUrl: string, contentHash: string): URL {
  return new URL(objectPath(contentHash), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

/** HTTP object-store CAS keyed only by contentHash. */
export class ObjectStoreResourceCas implements ResourceCas {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    if (baseUrl.length === 0) throw new Error("OBJECT_STORE_URL must be configured for object_store CAS");
    this.baseUrl = baseUrl;
  }

  async put(object: ResourceCasObject): Promise<void> {
    if (digest(object.content) !== object.contentHash) throw new Error("CAS content hash does not match bytes");
    const response = await fetch(objectUrl(this.baseUrl, object.contentHash), {
      method: "PUT",
      body: typeof object.content === "string" ? object.content : Buffer.from(object.content),
      headers: { "x-content-hash": object.contentHash },
    });
    if (!response.ok) throw new Error(`object-store CAS put failed (${response.status})`);
  }

  async get(contentHash: string): Promise<ResourceCasObject | undefined> {
    const response = await fetch(objectUrl(this.baseUrl, contentHash));
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`object-store CAS get failed (${response.status})`);
    const content = new Uint8Array(await response.arrayBuffer());
    if (digest(content) !== contentHash) throw new Error("object-store CAS content hash does not match bytes");
    return { contentHash, content };
  }

  async remove(_contentHash: string): Promise<void> {
    throw new Error("CAS objects are immutable and are not physically removed by the application");
  }
}
