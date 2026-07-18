import type {
  HostMemoryHost,
  HostMessage,
} from "./host-memory.ts";

export type LifecycleMemoryOperation = Record<string, unknown>;

export interface LifecycleMemoryExtractionInput {
  host: HostMemoryHost;
  sessionId: string;
  messages: HostMessage[];
  currentTurn?: {
    userPrompt?: string;
    finalAssistantMessage?: string;
  };
  evidence: {
    resourceId: string;
    revisionId: string;
    chunkIds: string[];
  };
  existingMemory: {
    rootName: string;
    branchRef: string;
    entities: Array<{
      name: string;
      summary: string;
      status: string;
      tags: string[];
    }>;
    tags: string[];
  };
}

export interface LifecycleMemoryExtractor {
  extract(
    input: LifecycleMemoryExtractionInput,
  ): Promise<LifecycleMemoryOperation[]>;
}

export type LifecycleMemoryExtractorProvider =
  | "openai_chat"
  | "ollama_chat";

export interface HttpLifecycleMemoryExtractorOptions {
  provider: LifecycleMemoryExtractorProvider;
  url: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const SYSTEM_PROMPT = [
  "You extract durable shared team knowledge from a conversation.",
  'Return JSON only in the shape {"operations":[]}.',
  "A memory_entity is only the stable subject/container and its high-level directory summary; it is not a fact and must never be created once per claim.",
  "Create or reuse one memory_entity per stable subject, then represent every concrete durable claim about that subject as its own memory_entity_branch operation.",
  "Use the complete conversation for disambiguation, but emit only durable knowledge introduced, confirmed, or corrected by currentTurn.",
  "A branch description must contain exactly one independently useful proposition. If it contains two claims joined by and/but/while, a list, multiple sentences, or independently changeable details, split it into multiple branches under the same entity.",
  "Do not hide concrete facts only in memory_entity.desc; every concrete claim must have a branch even when the entity summary mentions the topic.",
  "Use memory_relation operations for explicit relationships and contradictions.",
  "When evidence chunkIds are present, link each extracted atomic branch to the most relevant supplied resource_chunk with a refers_to relation.",
  "Reuse or refresh an existing entity when the catalog already identifies the same subject.",
  "Do not store user requests, assistant prose, formatting, transient progress, unsupported guesses, or lifecycle success/failure as semantic memory.",
  "Use only target/op/properties plus subject/object/type where required. Never generate ids, identity fields, root fields, branchRef, outcome, provenance, or clientMutationId.",
  "Entity properties use name, desc, tags, and optional status. Branch properties use name, desc, tags, and optional extra.",
  'Negative example for "Riverfront uses weekly reports, Mina owns them, and they are due Friday": do not create three memory_entity operations and do not create one compound branch containing all three claims.',
  'Positive example: {"operations":[{"target":"memory_entity","op":"create","properties":{"name":"Riverfront","desc":"Riverfront project knowledge"}},{"target":"memory_entity_branch","op":"create","subject":"Riverfront","properties":{"name":"Riverfront report cadence","desc":"Riverfront uses weekly status reports."}},{"target":"memory_entity_branch","op":"create","subject":"Riverfront","properties":{"name":"Riverfront report owner","desc":"Mina owns Riverfront weekly reports."}},{"target":"memory_entity_branch","op":"create","subject":"Riverfront","properties":{"name":"Riverfront report due day","desc":"Riverfront weekly reports are due every Friday."}}]}.',
  'If the conversation contains no durable knowledge, return {"operations":[]}.',
].join(" ");

export class HttpLifecycleMemoryExtractor implements LifecycleMemoryExtractor {
  private readonly provider: LifecycleMemoryExtractorProvider;
  private readonly url: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpLifecycleMemoryExtractorOptions) {
    this.provider = options.provider;
    this.url = options.url;
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async extract(
    input: LifecycleMemoryExtractionInput,
  ): Promise<LifecycleMemoryOperation[]> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.apiKey !== undefined) {
      headers.authorization = "Bearer " + this.apiKey;
    }
    const userContent = JSON.stringify({
      conversation: input.messages,
      currentTurn: input.currentTurn,
      evidence: input.evidence,
      existingMemory: input.existingMemory,
    });
    const body = this.provider === "ollama_chat"
      ? {
          model: this.model,
          stream: false,
          format: "json",
          options: { temperature: 0 },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
        }
      : {
          model: this.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
        };
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        "lifecycle memory extractor failed (" + response.status + ")",
      );
    }
    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: unknown } }>;
      message?: { content?: unknown };
      response?: unknown;
    };
    const content =
      payload.choices?.[0]?.message?.content ??
      payload.message?.content ??
      payload.response;
    if (typeof content !== "string") {
      throw new Error("lifecycle memory extractor returned no JSON content");
    }
    return operationsFromContent(content);
  }
}

function operationsFromContent(content: string): LifecycleMemoryOperation[] {
  const fence = String.fromCharCode(96).repeat(3);
  let cleaned = content.trim();
  if (cleaned.startsWith(fence)) {
    cleaned = cleaned.slice(fence.length).trimStart();
    if (cleaned.startsWith("json")) {
      cleaned = cleaned.slice("json".length).trimStart();
    }
    if (cleaned.endsWith(fence)) {
      cleaned = cleaned.slice(0, -fence.length).trimEnd();
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(cleaned);
  } catch {
    throw new Error("lifecycle memory extractor returned invalid JSON");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Array.isArray((value as { operations?: unknown }).operations)
  ) {
    throw new Error("lifecycle memory extractor must return operations[]");
  }
  return (value as { operations: unknown[] }).operations.map(
    (operation, index) => {
      if (
        operation === null ||
        typeof operation !== "object" ||
        Array.isArray(operation)
      ) {
        throw new Error(
          "lifecycle memory extractor operations[" + index + "] must be an object",
        );
      }
      return operation as LifecycleMemoryOperation;
    },
  );
}
