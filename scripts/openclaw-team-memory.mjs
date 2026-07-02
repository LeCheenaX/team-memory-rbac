#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.execArgv.includes("--experimental-strip-types")) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { env: process.env, stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}

const { createOpenClawTeamMemoryPluginFromEnv } = await import("../src/adapters/openclaw/plugin.ts");

const plugin = createOpenClawTeamMemoryPluginFromEnv(process.env);
const [command, toolName, payload = "{}"] = process.argv.slice(2);

if (command === "manifest") {
  console.log(JSON.stringify(plugin.manifest(), null, 2));
} else if (command === "tools") {
  console.log(JSON.stringify(plugin.tools(), null, 2));
} else if (command === "call" && toolName !== undefined) {
  console.log(JSON.stringify(await plugin.call(toolName, JSON.parse(payload)), null, 2));
} else {
  throw new Error("usage: openclaw-team-memory <manifest|tools|call TOOL JSON>");
}
