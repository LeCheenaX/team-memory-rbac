import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Hermes local compose setup and manual flow do not require server client tokens", async () => {
  const compose = await readFile("compose.hermes.yaml", "utf8");
  const manualFlow = await readFile("docs/operations/hermes-manual-v1-test.md", "utf8");

  assert.doesNotMatch(
    compose,
    /\$\{HERMES_[AB]_TOKEN:\?/,
    "Test 1 runs hermes-local before HERMES_A_TOKEN or HERMES_B_TOKEN exist, so compose parsing must not require them.",
  );
  assert.match(compose, /TEAM_MEMORY_TOKEN: \$\{LOCAL_HERMES_TOKEN:-\}/);
  assert.match(
    manualFlow,
    /Test 1 setup runs before `HERMES_A_TOKEN` and `HERMES_B_TOKEN` exist/,
  );
  assert.match(
    manualFlow,
    /Do not set `HERMES_A_TOKEN` or `HERMES_B_TOKEN` for Test 1/,
  );
  assert.match(
    manualFlow,
    /one-shot containers and Docker removes each container when its command exits/,
  );
  assert.match(manualFlow, /`hermes-local-home` is mounted at `\/root\/\.hermes`/);
  assert.match(manualFlow, /hermes setup/);
  assert.match(manualFlow, /hermes-a hermes setup/);
  assert.match(manualFlow, /hermes-b hermes setup/);
  assert.match(manualFlow, /session:test1-hermes-readonly 2030-01-01T00:00:00\.000Z read-only/);
  assert.doesNotMatch(manualFlow, /\$readOnly =/);
  assert.match(
    manualFlow,
    /The conversation begins only after a command[\s\S]+hermes-local hermes/,
  );
});
