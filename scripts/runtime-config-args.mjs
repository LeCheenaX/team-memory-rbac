import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function repoRootFrom(importMetaUrl) {
  return dirname(dirname(fileURLToPath(importMetaUrl)));
}

export function parseRuntimeConfigArgs(argv, importMetaUrl) {
  const repoRoot = repoRootFrom(importMetaUrl);
  const args = [...argv];
  let configPath;
  const cleaned = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--config") {
      configPath = args[index + 1];
      if (configPath === undefined || configPath.length === 0) {
        throw new Error("--config requires a path");
      }
      index += 1;
      continue;
    }
    cleaned.push(arg);
  }
  const defaultPath = join(repoRoot, "config", "team-memory.local.json");
  return {
    configPath: configPath ?? defaultPath,
    args: cleaned,
  };
}

export function resolveConfigPath(path) {
  if (existsSync(path)) return path;
  throw new Error(`Team Memory config file not found: ${path}`);
}
