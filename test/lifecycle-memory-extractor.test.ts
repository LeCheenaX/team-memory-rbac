import assert from "node:assert/strict";
import test from "node:test";

import {
  HttpLifecycleMemoryExtractor,
  type LifecycleMemoryExtractionInput,
} from "../src/adapters/lifecycle/memory-extractor.ts";
import { loadRuntimeConfig } from "../src/adapters/runtime/development-stack.ts";

const input: LifecycleMemoryExtractionInput = {
  host: "hermes",
  sessionId: "session-1",
  messages: [
    { role: "user", content: "Riverfront is the churn pilot." },
    { role: "assistant", content: "OpenClaw pushes ticket summaries to it." },
  ],
  currentTurn: {
    userPrompt: "Riverfront is the churn pilot.",
    finalAssistantMessage: "OpenClaw pushes ticket summaries to it.",
  },
  evidence: {
    resourceId: "resource-1",
    revisionId: "revision-1",
    chunkIds: ["chunk-1"],
  },
  existingMemory: {
    rootName: "Team Memory",
    branchRef: "main",
    entities: [],
    tags: [],
  },
};

test("OpenAI lifecycle extractor sends all context without outcome and parses operations", async () => {
  const expectedOperations = [
    {
      target: "memory_entity",
      op: "create",
      properties: {
        name: "Riverfront",
        desc: "Customer churn warning pilot.",
      },
    },
    {
      target: "memory_entity_branch",
      op: "create",
      subject: "Riverfront",
      properties: {
        name: "Riverfront purpose",
        desc: "Riverfront is the customer churn warning pilot.",
      },
    },
  ];
  let requestBody: Record<string, unknown> | undefined;
  const extractor = new HttpLifecycleMemoryExtractor({
    provider: "openai_chat",
    url: "https://llm.example/v1/chat/completions",
    model: "test-model",
    apiKey: "secret",
    fetch: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({ operations: expectedOperations }),
          },
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.deepEqual(await extractor.extract(input), expectedOperations);
  assert.ok(requestBody);
  const messages = requestBody.messages as Array<{
    role: string;
    content: string;
  }>;
  const modelInput = JSON.parse(messages[1]?.content ?? "{}") as Record<
    string,
    unknown
  >;
  assert.deepEqual(modelInput.conversation, input.messages);
  assert.equal("outcome" in modelInput, false);
  assert.match(messages[0]?.content ?? "", /atomic memory_entity_branch/);
});

test("Ollama lifecycle extractor uses native chat response shape", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const extractor = new HttpLifecycleMemoryExtractor({
    provider: "ollama_chat",
    url: "http://ollama:11434/api/chat",
    model: "qwen",
    fetch: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        message: {
          content: JSON.stringify({ operations: [] }),
        },
      }), { status: 200 });
    },
  });

  assert.deepEqual(await extractor.extract(input), []);
  assert.equal(requestBody?.stream, false);
  assert.equal(requestBody?.format, "json");
});

test("runtime config creates an optional lifecycle extractor", () => {
  const runtime = loadRuntimeConfig({
    runtimeMode: "unitTest",
    libsql: { url: "file:test.db" },
    cas: { backend: "filesystem", directory: ".data/cas" },
    qdrant: { url: "http://qdrant" },
    embedding: {
      provider: "deterministic",
      url: "deterministic://unit-test",
    },
    lifecycleExtraction: {
      provider: "openai_chat",
      url: "https://llm.example/v1/chat/completions",
      model: "test-model",
    },
  });

  assert.ok(runtime.lifecycleMemoryExtractor instanceof HttpLifecycleMemoryExtractor);
});
