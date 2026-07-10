import { join } from "node:path";

import {
  DeterministicEmbeddingProvider,
  type EmbeddingProvider,
} from "../../src/ingestion/service.ts";
import type {
  RuntimeConfig,
  RuntimeConfigDocument,
} from "../../src/adapters/runtime/development-stack.ts";

export function unitTestEmbeddingProvider(): EmbeddingProvider {
  return new DeterministicEmbeddingProvider();
}

export function unitTestRuntimeConfig(input: {
  directory: string;
  databaseName?: string;
  qdrantUrl?: string;
}): RuntimeConfig {
  return {
    runtimeMode: "unitTest",
    libsqlUrl: `file:${join(input.directory, input.databaseName ?? "team-memory.db")}`,
    casBackend: "filesystem",
    casDirectory: join(input.directory, "cas"),
    qdrantUrl: input.qdrantUrl ?? "http://127.0.0.1:6333",
    embeddings: unitTestEmbeddingProvider(),
    embeddingProviderUrl: "deterministic://unit-test",
  };
}

export function unitTestRuntimeConfigDocument(input: {
  directory: string;
  databaseName?: string;
  qdrantUrl?: string;
}): RuntimeConfigDocument {
  return {
    runtimeMode: "unitTest",
    libsql: {
      url: `file:${join(input.directory, input.databaseName ?? "team-memory.db")}`,
    },
    cas: {
      backend: "filesystem",
      directory: join(input.directory, "cas"),
    },
    qdrant: {
      url: input.qdrantUrl ?? "http://127.0.0.1:6333",
    },
    embedding: {
      provider: "deterministic",
      url: "deterministic://unit-test",
    },
  };
}
