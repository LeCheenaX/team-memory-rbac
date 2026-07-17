#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { clearTestMemory } from "../src/adapters/runtime/test-memory-maintenance.ts";

function parseArguments(argv) {
  const configIndex = argv.indexOf("--config");
  if (configIndex < 0 || argv[configIndex + 1] === undefined) {
    throw new Error("Usage: clear-test-memory --config <path> [--skip-vectors] [--skip-filesystem-cas] [--object-store-cas-directory <path>]");
  }
  const objectStoreDirectoryIndex = argv.indexOf("--object-store-cas-directory");
  return {
    configPath: argv[configIndex + 1],
    skipVectors: argv.includes("--skip-vectors"),
    skipFilesystemCas: argv.includes("--skip-filesystem-cas"),
    objectStoreCasDirectory: objectStoreDirectoryIndex < 0
      ? undefined
      : argv[objectStoreDirectoryIndex + 1],
  };
}

const options = parseArguments(process.argv.slice(2));
const config = JSON.parse(await readFile(options.configPath, "utf8"));
const result = await clearTestMemory(config, {
  skipVectors: options.skipVectors,
  skipFilesystemCas: options.skipFilesystemCas,
  objectStoreCasDirectory: options.objectStoreCasDirectory,
});
console.log(JSON.stringify(result));

