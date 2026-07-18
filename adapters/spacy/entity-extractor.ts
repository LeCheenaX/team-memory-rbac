import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { EntityExtractor } from "../../src/memory/retrieval.ts";

export type SpacyExtractionRunner = (
  text: string,
  maxAtoms: number,
) => string[];

function runPythonSpacyExtraction(text: string, maxAtoms: number): string[] {
  const python = process.env.TEAM_MEMORY_SPACY_PYTHON ?? "python3";
  const script = fileURLToPath(new URL("./query-extractor.py", import.meta.url));
  let output: string;
  try {
    output = execFileSync(python, [script, text, String(maxAtoms)], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(
      `spaCy query extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new Error("spaCy query extraction returned an invalid response");
  }
  return parsed;
}

export class SpacyEntityExtractor implements EntityExtractor {
  private readonly runner: SpacyExtractionRunner;
  private readonly maxAtoms: number;

  constructor(
    runner: SpacyExtractionRunner = runPythonSpacyExtraction,
    maxAtoms = 8,
  ) {
    this.runner = runner;
    this.maxAtoms = maxAtoms;
  }

  extract(text: string): string[] {
    return [...new Set(
      this.runner(text, this.maxAtoms).map((value) => value.trim()).filter(Boolean),
    )].slice(0, this.maxAtoms);
  }
}
