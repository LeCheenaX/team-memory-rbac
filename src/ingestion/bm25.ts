export interface Bm25Document {
  id: string;
  rootEntityId: string;
  branchRef: string;
  resourceId: string;
  revisionId: string;
  chunkId: string;
  text: string;
  status: "active" | "tombstoned";
}

export interface Bm25SearchOptions {
  rootEntityId: string;
  branchRef: string;
  text: string;
  limit?: number;
  allowedResourceIds?: string[];
  deniedResourceIds?: string[];
}

export interface Bm25SearchResult {
  document: Bm25Document;
  score: number;
}

export interface Bm25Index {
  upsertDocuments(documents: Bm25Document[]): Promise<void>;
  replaceRevision(input: {
    rootEntityId: string;
    branchRef: string;
    resourceId: string;
    revisionId: string;
    documents: Bm25Document[];
  }): Promise<void>;
  search(options: Bm25SearchOptions): Promise<Bm25SearchResult[]>;
}

function tokenize(text: string): string[] {
  return text
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length > 0);
}

function scoreDocuments(
  documents: Bm25Document[],
  query: string,
  limit: number,
): Bm25SearchResult[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) {
    return [];
  }
  const tokenized = documents.map((document) => ({
    document,
    terms: tokenize(document.text),
  }));
  const averageLength =
    tokenized.reduce((sum, item) => sum + item.terms.length, 0) /
    Math.max(tokenized.length, 1);
  const k1 = 1.2;
  const b = 0.75;
  const scored = tokenized.map(({ document, terms }) => {
    let score = 0;
    for (const term of queryTerms) {
      const frequency = terms.filter((candidate) => candidate === term).length;
      if (frequency === 0) {
        continue;
      }
      const containing = tokenized.filter((candidate) =>
        candidate.terms.includes(term),
      ).length;
      const idf = Math.log(1 + (tokenized.length - containing + 0.5) / (containing + 0.5));
      score +=
        idf *
        ((frequency * (k1 + 1)) /
          (frequency + k1 * (1 - b + b * (terms.length / averageLength))));
    }
    return { document, score };
  });
  return scored
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export class InMemoryBm25Index implements Bm25Index {
  private readonly documents = new Map<string, Bm25Document>();

  async upsertDocuments(documents: Bm25Document[]): Promise<void> {
    for (const document of documents) {
      this.documents.set(document.id, structuredClone(document));
    }
  }

  async replaceRevision(input: {
    rootEntityId: string;
    branchRef: string;
    resourceId: string;
    revisionId: string;
    documents: Bm25Document[];
  }): Promise<void> {
    for (const [id, document] of this.documents) {
      if (
        document.rootEntityId === input.rootEntityId &&
        document.branchRef === input.branchRef &&
        document.resourceId === input.resourceId &&
        document.revisionId === input.revisionId
      ) {
        this.documents.delete(id);
      }
    }
    for (const document of input.documents) {
      this.documents.set(document.id, structuredClone(document));
    }
  }

  async search(options: Bm25SearchOptions): Promise<Bm25SearchResult[]> {
    const denied = new Set(options.deniedResourceIds ?? []);
    const candidates = [...this.documents.values()].filter(
      (document) =>
        document.rootEntityId === options.rootEntityId &&
        document.branchRef === options.branchRef &&
        document.status === "active" &&
        (options.allowedResourceIds === undefined ||
          options.allowedResourceIds.includes(document.resourceId)) &&
        !denied.has(document.resourceId),
    );
    return scoreDocuments(candidates, options.text, options.limit ?? 20);
  }
}

export const bm25Internals = {
  scoreDocuments,
  tokenize,
};
