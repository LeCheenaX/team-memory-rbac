import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("evaluation reuses the installed hermes-local CLI without unsupported overrides", async () => {
  const runner = await readFile("test/evaluation/run.mjs", "utf8");
  const launcher = await readFile("test/evaluation/run.ps1", "utf8");

  assert.match(launcher, /compose\.hermes\.yaml/);
  assert.match(launcher, /hermes-local/);
  assert.doesNotMatch(runner, /["']--(?:provider|model|max-turns)["']/);
  assert.doesNotMatch(runner, /hermes[^\n]*config[^\n]*set/);
  assert.doesNotMatch(launcher, /test[\\/]evaluation[\\/]compose\.yaml/);
});

test("reset targets only the exact local Test 1 stores and preserves configuration", async () => {
  const reset = await readFile("test/evaluation/reset.ps1", "utf8");
  const resetImplementation = await readFile("test/evaluation/reset-memory.mjs", "utf8");

  assert.match(reset, /hermes-local/);
  assert.doesNotMatch(reset, /hermes-local-home|down\s+--volumes/);
  assert.match(resetImplementation, /root:test1-local/);
  assert.match(resetImplementation, /rootEntityId/);
  assert.match(resetImplementation, /rbac_\*/);
  assert.match(
    resetImplementation,
    /\/workspace\/\.data\/test1-local-hermes\/team-memory\.db/,
  );
  assert.match(
    resetImplementation,
    /\/workspace\/\.data\/test1-local-hermes\/cas/,
  );
  assert.match(resetImplementation, /http:\/\/qdrant:6333/);
});
