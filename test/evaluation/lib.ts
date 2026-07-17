import { createHash } from "node:crypto";

export interface HotpotExample {
  _id: string;
  answer: string;
  question: string;
  supporting_facts: [string, number][];
  context: [string, string[]][];
  type: string;
  level: string;
}

export interface Probe {
  fact: string;
  question: string;
  answer: string;
}

export interface AnswerScore {
  exactMatch: number;
  f1: number;
  precision: number;
  recall: number;
}

const probeWords = [
  "AMBER", "BIRCH", "CEDAR", "DELTA", "EMBER", "FJORD",
  "GLYPH", "HERON", "IVORY", "KITE", "LOTUS", "MAPLE",
] as const;
const specialAnswers = new Set(["yes", "no", "noanswer"]);

function digest(input: string): Buffer {
  return createHash("sha256").update(input).digest();
}

export function selectExamples(
  examples: readonly HotpotExample[],
  count: number,
  seed: string,
): HotpotExample[] {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("count must be a positive integer");
  }

  const byId = new Map<string, HotpotExample>();
  for (const example of examples) {
    if (!example._id || !example.question || !example.answer) continue;
    if (!Array.isArray(example.context) || example.context.length !== 10) continue;
    byId.set(example._id, example);
  }
  if (byId.size < count) {
    throw new Error(`dataset has only ${byId.size} valid unique examples; ${count} required`);
  }

  return [...byId.values()]
    .map((example) => ({
      example,
      rank: digest(`${seed}:${example._id}`).toString("hex"),
    }))
    .sort((left, right) => left.rank.localeCompare(right.rank))
    .slice(0, count)
    .map(({ example }) => example);
}

export function createProbe(exampleId: string, seed: string): Probe {
  const bytes = digest(`${seed}:probe:${exampleId}`);
  const word = probeWords[bytes[0]! % probeWords.length];
  const number = 100 + (bytes.readUInt16BE(1) % 900);
  const answer = `${word}-${number}`;
  return {
    fact: `Evaluation code for ${exampleId} is ${answer}.`,
    question: `What is the evaluation code for ${exampleId}?`,
    answer,
  };
}

function normalizeAnswer(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\b(a|an|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function scoreAnswer(prediction: string, expected: string): AnswerScore {
  const normalizedPrediction = normalizeAnswer(prediction);
  const normalizedExpected = normalizeAnswer(expected);
  const zero = { exactMatch: 0, f1: 0, precision: 0, recall: 0 };
  if (
    normalizedPrediction !== normalizedExpected
    && (specialAnswers.has(normalizedPrediction) || specialAnswers.has(normalizedExpected))
  ) {
    return zero;
  }

  const predictionTokens = normalizedPrediction ? normalizedPrediction.split(" ") : [];
  const expectedTokens = normalizedExpected ? normalizedExpected.split(" ") : [];
  if (predictionTokens.length === 0 || expectedTokens.length === 0) {
    const same = normalizedPrediction === normalizedExpected ? 1 : 0;
    return { exactMatch: same, f1: same, precision: same, recall: same };
  }

  const remaining = new Map<string, number>();
  for (const token of expectedTokens) {
    remaining.set(token, (remaining.get(token) ?? 0) + 1);
  }
  let common = 0;
  for (const token of predictionTokens) {
    const available = remaining.get(token) ?? 0;
    if (available > 0) {
      common += 1;
      remaining.set(token, available - 1);
    }
  }
  const precision = common / predictionTokens.length;
  const recall = common / expectedTokens.length;
  const f1 = common === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    exactMatch: normalizedPrediction === normalizedExpected ? 1 : 0,
    f1,
    precision,
    recall,
  };
}

export function parseHermesAnswer(output: string): {
  datasetAnswer: string;
  probeAnswer: string;
} {
  const candidates = output.match(/\{[^{}]*\}/gs) ?? [];
  for (const candidate of candidates.reverse()) {
    try {
      const value = JSON.parse(candidate) as Record<string, unknown>;
      if (
        typeof value.dataset_answer === "string"
        && typeof value.probe_answer === "string"
      ) {
        return {
          datasetAnswer: value.dataset_answer,
          probeAnswer: value.probe_answer,
        };
      }
    } catch {
      // Continue looking for the final structured object in noisy CLI output.
    }
  }
  throw new Error("Hermes output did not contain dataset_answer and probe_answer JSON");
}

export function formatContext(example: HotpotExample): string {
  return example.context
    .map(([title, sentences]) => `## ${title}\n${sentences.join(" ")}`)
    .join("\n\n");
}
