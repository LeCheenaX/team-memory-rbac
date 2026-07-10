import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Hermes local compose setup and manual flow do not require server client tokens", async () => {
  const baseCompose = await readFile("compose.yaml", "utf8");
  const compose = await readFile("compose.hermes.yaml", "utf8");
  const packageJson = await readFile("package.json", "utf8");
  const manualFlow = await readFile("docs/operations/hermes-manual-v1-test.md", "utf8");
  const hermesConfig = JSON.parse(
    await readFile("config/team-memory.hermes-local.json", "utf8"),
  ) as {
    runtimeMode: string;
    embedding: { provider: string; url: string; model?: string };
    activation?: unknown;
  };

  assert.doesNotMatch(
    compose,
    /\$\{HERMES_[AB]_TOKEN:\?/,
    "Test 1 runs hermes-local before HERMES_A_TOKEN or HERMES_B_TOKEN exist, so compose parsing must not require them.",
  );
  assert.match(compose, /TEAM_MEMORY_TOKEN: \$\{TEAM_MEMORY_TOKEN:-\}/);
  assert.match(compose, /TEAM_MEMORY_MODE: local/);
  assert.match(compose, /TEAM_MEMORY_MODE: http/);
  assert.match(compose, /TEAM_MEMORY_CONFIG_FILE: \/workspace\/config\/team-memory\.hermes-local\.json/);
  assert.match(compose, /TEAM_MEMORY_SESSION_FILE: \/root\/\.hermes\/team-memory-session\.json/);
  assert.match(compose, /BOOTSTRAP_USER_PASSWORD: \$\{BOOTSTRAP_USER_PASSWORD:-\}/);
  assert.doesNotMatch(compose, /LIBSQL_URL:/);
  assert.doesNotMatch(compose, /CAS_BACKEND:/);
  assert.doesNotMatch(compose, /QDRANT_URL:/);
  assert.doesNotMatch(compose, /EMBEDDING_PROVIDER:/);
  assert.match(baseCompose, /--config", "config\/team-memory\.service\.json"/);
  assert.doesNotMatch(baseCompose, /LIBSQL_URL:/);
  assert.doesNotMatch(baseCompose, /CAS_BACKEND:/);
  assert.doesNotMatch(baseCompose, /QDRANT_URL:/);
  assert.doesNotMatch(baseCompose, /EMBEDDING_PROVIDER:/);
  assert.doesNotMatch(packageJson, /"login": "[^"]*--config config\/team-memory\.hermes-local\.json/);
  assert.equal(hermesConfig.runtimeMode, "Dev");
  assert.equal(hermesConfig.embedding.provider, "http");
  assert.match(hermesConfig.embedding.url, /^http:\/\//);
  assert.equal(typeof hermesConfig.embedding.model, "string");
  assert.equal(hermesConfig.activation, undefined);
  assert.match(manualFlow, /Dev` and `Production` must use a real HTTP embedding provider/);
  assert.match(manualFlow, /team-memory setup --config <config-path>/);
  assert.match(manualFlow, /validates\s+the configured embedding model/);
  assert.match(manualFlow, /writes an `activation` record/);
  assert.match(manualFlow, /intentionally inactive/);
  assert.match(
    manualFlow,
    /run team -- --config \/workspace\/config\/team-memory\.hermes-local\.json setup/,
  );
  assert.match(
    manualFlow,
    /npm\.cmd run team -- --config config\/team-memory\.server-local\.json setup/,
  );
  assert.doesNotMatch(manualFlow, /deterministic embedding provider URL/);
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
  assert.match(manualFlow, /hermes memory setup team_memory/);
  assert.match(manualFlow, /Provider: team_memory/);
  assert.match(manualFlow, /entity\/tag catalog/);
  assert.match(manualFlow, /memory\.catalog/);
  assert.match(manualFlow, /tagsAny/);
  assert.match(manualFlow, /\$env:BOOTSTRAP_USER_PASSWORD = "<test local admin password>"/);
  assert.match(manualFlow, /请输入用户名/);
  assert.match(manualFlow, /请输入密码/);
  assert.match(manualFlow, /登录成功/);
  assert.match(manualFlow, /npm --prefix \/opt\/team-memory-rbac run login user:test1-admin/);
  assert.match(manualFlow, /npm --prefix \/opt\/team-memory-rbac run login admin adminpswd/);
  assert.match(manualFlow, /config\/team-memory\.hermes-local\.json/);
  assert.match(manualFlow, /team-memory-session\.json/);
  assert.match(manualFlow, /Reset the Hermes conversation before testing recall/);
  assert.match(manualFlow, /\/reset/);
  assert.match(manualFlow, /cannot be satisfied from the model's short-term/);
  assert.match(manualFlow, /missing\s+`userPrompt`\/query parameter fails this step/);
  assert.match(manualFlow, /"tag": "memory-context"/);
  assert.match(manualFlow, /<team-memory-context \.\.\.>/);
  assert.match(manualFlow, /self-referential recall or inspection turns/);
  assert.match(manualFlow, /under `extra`, not as ad hoc fields/);
  assert.match(manualFlow, /Resource\/CAS path/);
  assert.doesNotMatch(manualFlow, /Inside Hermes, configure the Team Memory provider with/);
  assert.match(manualFlow, /team -- --config \/workspace\/config\/team-memory\.hermes-local\.json members create user:test1-readonly Test1ReadOnly/);
  assert.match(manualFlow, /team -- logout/);
  assert.match(manualFlow, /run login user:test1-readonly/);
  assert.doesNotMatch(manualFlow, /\$env:LIBSQL_URL/);
  assert.doesNotMatch(manualFlow, /\$env:CAS_BACKEND/);
  assert.doesNotMatch(manualFlow, /\$env:QDRANT_URL/);
  assert.doesNotMatch(manualFlow, /\$readOnly =/);
  assert.match(
    manualFlow,
    /The conversation begins only after a command[\s\S]+hermes-local hermes/,
  );
});
