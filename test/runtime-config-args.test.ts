import assert from "node:assert/strict";
import test from "node:test";

import { parseRuntimeConfigArgs } from "../scripts/runtime-config-args.mjs";

test("runtime config args use explicit --config before TEAM_MEMORY_CONFIG_FILE", () => {
  const previous = process.env.TEAM_MEMORY_CONFIG_FILE;
  process.env.TEAM_MEMORY_CONFIG_FILE = "/workspace/config/team-memory.hermes-local.json";
  try {
    assert.deepEqual(
      parseRuntimeConfigArgs(["login"], import.meta.url),
      {
        configPath: "/workspace/config/team-memory.hermes-local.json",
        args: ["login"],
      },
    );
    assert.deepEqual(
      parseRuntimeConfigArgs(["--config", "custom.json", "login"], import.meta.url),
      {
        configPath: "custom.json",
        args: ["login"],
      },
    );
  } finally {
    if (previous === undefined) {
      delete process.env.TEAM_MEMORY_CONFIG_FILE;
    } else {
      process.env.TEAM_MEMORY_CONFIG_FILE = previous;
    }
  }
});
