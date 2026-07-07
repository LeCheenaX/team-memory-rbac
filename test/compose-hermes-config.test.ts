import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Hermes local compose setup does not require server client tokens", async () => {
  const compose = await readFile("compose.hermes.yaml", "utf8");

  assert.doesNotMatch(
    compose,
    /\$\{HERMES_[AB]_TOKEN:\?/,
    "Test 1 runs hermes-local before HERMES_A_TOKEN or HERMES_B_TOKEN exist, so compose parsing must not require them.",
  );
  assert.match(compose, /TEAM_MEMORY_TOKEN: \$\{LOCAL_HERMES_TOKEN:-\}/);
});
