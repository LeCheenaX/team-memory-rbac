#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { formatContext, parseHermesAnswer, scoreAnswer } from "./lib.ts";

const evaluationRoot = process.env.HERMES_EVAL_DATA_ROOT ?? "/evaluation";
const selectionPath = resolve(evaluationRoot, "hotpotqa/hotpotqa-dev-distractor-20.json");
const resultsRoot = resolve(evaluationRoot, "results");
const runLabel = process.env.HERMES_EVAL_LABEL ?? "hermes-local-configured-model";
const batchSize = 5;

function callHermes(prompt) {
  const startedAt = performance.now();
  const result = spawnSync("hermes", ["-z", prompt], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  const durationMs = Math.round(performance.now() - startedAt);
  return {
    ok: result.status === 0 && result.error === undefined,
    status: result.status,
    output: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    error: result.error?.message,
    durationMs,
  };
}

function failureMessage(response) {
  return [
    response.error,
    response.status === null ? undefined : `exit status ${response.status}`,
    response.stderr,
  ].filter(Boolean).join(": ");
}

function ingestionPrompt(batch, batchNumber) {
  const records = batch.map((example) => [
    `<memory_record id="${example._id}">`,
    `Original question: ${example.question}`,
    "Source documents:",
    formatContext(example),
    `Memory probe fact: ${example.memory_probe.fact}`,
    "</memory_record>",
  ].join("\n")).join("\n\n");
  return [
    "Store the following benchmark records as user-provided long-term memory.",
    "Do not solve their questions and do not use external tools. Preserve every record ID, source document, and memory probe fact.",
    `After reading them, reply exactly MEMORY_BATCH_STORED_${batchNumber}.`,
    "",
    records,
  ].join("\n");
}

function queryPrompt(example) {
  return [
    "This is a closed-book long-term-memory test.",
    "You MUST call team_memory_search to retrieve the previously stored record. Do not use web, browser, filesystem, or general world knowledge.",
    `Retrieve memory_record id ${example._id} and answer both questions:`,
    `1. Dataset question: ${example.question}`,
    `2. Memory probe: ${example.memory_probe.question}`,
    "Return only one JSON object with this exact shape:",
    '{"dataset_answer":"short answer","probe_answer":"CODE-123"}',
  ].join("\n");
}

const selection = JSON.parse(await readFile(selectionPath, "utf8"));
if (!Array.isArray(selection.examples) || selection.examples.length !== 20) {
  throw new Error("prepared selection must contain exactly 20 examples");
}

const runStarted = new Date();
const wallStarted = performance.now();
let ingestionDurationMs = 0;
let estimatedHarnessInputTokens = 0;
for (let offset = 0; offset < selection.examples.length; offset += batchSize) {
  const batch = selection.examples.slice(offset, offset + batchSize);
  const prompt = ingestionPrompt(batch, offset / batchSize + 1);
  estimatedHarnessInputTokens += Math.ceil(prompt.length / 4);
  const response = callHermes(prompt);
  if (!response.ok) {
    throw new Error(`Hermes ingestion batch ${offset / batchSize + 1} failed: ${failureMessage(response)}`);
  }
  ingestionDurationMs += response.durationMs;
  console.log(`Stored memory batch ${offset / batchSize + 1}/4 (${response.durationMs} ms)`);
}

const results = [];
for (const [index, example] of selection.examples.entries()) {
  const prompt = queryPrompt(example);
  estimatedHarnessInputTokens += Math.ceil(prompt.length / 4);
  const response = callHermes(prompt);
  let parsed;
  let error = response.ok ? undefined : `Hermes call failed: ${failureMessage(response)}`;
  if (response.ok) {
    try {
      parsed = parseHermesAnswer(response.output);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }
  const datasetScore = parsed
    ? scoreAnswer(parsed.datasetAnswer, example.answer)
    : scoreAnswer("", example.answer);
  const probeScore = parsed
    ? scoreAnswer(parsed.probeAnswer, example.memory_probe.answer)
    : scoreAnswer("", example.memory_probe.answer);
  results.push({
    id: example._id,
    question: example.question,
    expectedDatasetAnswer: example.answer,
    expectedProbeAnswer: example.memory_probe.answer,
    predictedDatasetAnswer: parsed?.datasetAnswer ?? null,
    predictedProbeAnswer: parsed?.probeAnswer ?? null,
    datasetScore,
    probeExactMatch: probeScore.exactMatch,
    durationMs: response.durationMs,
    hermesExitStatus: response.status,
    rawOutput: response.output,
    rawStderr: response.stderr,
    error: error ?? null,
  });
  console.log(
    `[${index + 1}/20] dataset EM=${datasetScore.exactMatch} F1=${datasetScore.f1.toFixed(3)} probe=${probeScore.exactMatch} (${response.durationMs} ms)`,
  );
}

const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const summary = {
  benchmark: selection.benchmark,
  seed: selection.seed,
  runLabel,
  hermesModelSource: "existing /root/.hermes configuration",
  examples: results.length,
  hermesInvocations: 4 + results.length,
  datasetExactMatch: average(results.map((result) => result.datasetScore.exactMatch)),
  datasetF1: average(results.map((result) => result.datasetScore.f1)),
  probeExactMatch: average(results.map((result) => result.probeExactMatch)),
  failedQueries: results.filter((result) => result.error !== null).length,
  estimatedHarnessInputTokens,
  usageNote: "Hermes/model system prompts, tool calls, retrieved content, outputs, and provider-billed tokens are not included.",
  ingestionDurationMs,
  queryDurationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
  wallDurationMs: Math.round(performance.now() - wallStarted),
  startedAt: runStarted.toISOString(),
  finishedAt: new Date().toISOString(),
};
const runDirectory = resolve(resultsRoot, runStarted.toISOString().replaceAll(":", "-"));
await mkdir(runDirectory, { recursive: true });
await writeFile(resolve(runDirectory, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
await writeFile(resolve(runDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\n${JSON.stringify(summary, null, 2)}`);
console.log(`Results written to ${runDirectory}`);
