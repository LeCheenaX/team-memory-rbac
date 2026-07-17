#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { createProbe, selectExamples } from "./lib.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const dataDirectory = resolve(repoRoot, ".data/evaluation/hotpotqa");
const sourcePath = resolve(dataDirectory, "hotpot_dev_distractor_v1.json");
const selectionPath = resolve(dataDirectory, "hotpotqa-dev-distractor-20.json");
const sources = [
  {
    url: "https://curtis.ml.cmu.edu/datasets/hotpot/hotpot_dev_distractor_v1.json",
    sha256: "4e9ecb5c8d3b719f624d66b60f8d56bf227f03914f5f0753d6fa1b359d7104ea",
    bytes: 46_320_117,
  },
  {
    url: "https://huggingface.co/datasets/namlh2004/hotpotqa/resolve/7e54db4656209750ff487f6fdf8e39a66dba136b/hotpot_dev_distractor_v1.json?download=true",
    sha256: "e3da074df24e8369009918aa5cdbdd254dadcde4c63f7569d36afd6f2268caa8",
  },
];
const seed = "hotpot-memory-v1";

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function sourceIsValid() {
  try {
    const bytes = (await stat(sourcePath)).size;
    const checksum = await sha256(sourcePath);
    return sources.some((source) => source.sha256 === checksum
      && (source.bytes === undefined || source.bytes === bytes));
  } catch {
    return false;
  }
}

async function downloadSource() {
  await mkdir(dataDirectory, { recursive: true });
  if (await sourceIsValid()) {
    console.log(`Using verified HotpotQA source: ${sourcePath}`);
    return;
  }

  const temporaryPath = `${sourcePath}.part`;
  await rm(temporaryPath, { force: true });
  const failures = [];
  for (const source of sources) {
    try {
      console.log(`Downloading ${source.url}`);
      const response = await fetch(source.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporaryPath));
      const actualBytes = (await stat(temporaryPath)).size;
      const actualSha256 = await sha256(temporaryPath);
      if (
        actualSha256 !== source.sha256
        || (source.bytes !== undefined && actualBytes !== source.bytes)
      ) {
        throw new Error(`integrity mismatch (bytes=${actualBytes}, sha256=${actualSha256})`);
      }
      await rename(temporaryPath, sourcePath);
      return;
    } catch (error) {
      failures.push(`${source.url}: ${error instanceof Error ? error.message : String(error)}`);
      await rm(temporaryPath, { force: true });
    }
  }
  throw new Error(`all HotpotQA downloads failed:\n${failures.join("\n")}`);
}

await downloadSource();
const source = JSON.parse(await readFile(sourcePath, "utf8"));
if (!Array.isArray(source) || source.length !== 7_405) {
  throw new Error(`expected 7405 HotpotQA dev-distractor examples, found ${source.length}`);
}
const examples = selectExamples(source, 20, seed).map((example) => ({
  ...example,
  memory_probe: createProbe(example._id, seed),
}));
const actualBytes = (await stat(sourcePath)).size;
const actualSha256 = await sha256(sourcePath);
const selectedSource = sources.find((candidate) => candidate.sha256 === actualSha256);
const selection = {
  benchmark: "hotpotqa-dev-distractor-memory",
  version: 1,
  seed,
  license: "CC BY-SA 4.0",
  source: {
    url: selectedSource?.url,
    sha256: actualSha256,
    bytes: actualBytes,
    totalExamples: source.length,
  },
  selectedExamples: examples.length,
  examples,
};
await writeFile(selectionPath, `${JSON.stringify(selection, null, 2)}\n`);
console.log(`Prepared ${examples.length} deterministic examples: ${selectionPath}`);
