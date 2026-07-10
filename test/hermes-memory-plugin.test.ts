import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Team Memory ships as a real Hermes memory plugin", async () => {
  const [plugin, metadata] = await Promise.all([
    readFile("adapters/hermes/team_memory_plugin/__init__.py", "utf8"),
    readFile("adapters/hermes/team_memory_plugin/plugin.yaml", "utf8"),
  ]);

  assert.match(plugin, /from agent\.memory_provider import MemoryProvider/);
  assert.match(plugin, /sys\.path\.insert\(0, _REPO_ROOT\)/);
  assert.match(plugin, /class TeamMemoryHermesProvider\(MemoryProvider\)/);
  assert.match(plugin, /def register\(ctx/);
  assert.match(plugin, /ctx\.register_memory_provider\(TeamMemoryHermesProvider\(\)\)/);
  assert.match(plugin, /TEAM_MEMORY_MODE/);
  assert.match(plugin, /TEAM_MEMORY_CONFIG_FILE/);
  assert.match(plugin, /\/workspace\/config\/team-memory\.hermes-local\.json/);
  assert.match(plugin, /TEAM_MEMORY_SESSION_FILE/);
  assert.match(plugin, /def _session_token/);
  assert.match(plugin, /agentSessionToken/);
  assert.match(plugin, /return bool\(_session_token\(\)\)/);
  assert.match(plugin, /Variable metadata appears under extra/);
  assert.match(plugin, /names/);
  assert.doesNotMatch(plugin, /entityIds/);
  assert.doesNotMatch(plugin, /tagsNone/);
  assert.match(plugin, /team_memory_catalog/);
  assert.match(plugin, /Pass content and optional outcome/);
  assert.match(plugin, /import the resource into Team Memory\/CAS/);
  assert.doesNotMatch(plugin, /includeHistory/);
  assert.doesNotMatch(plugin, /oldClaim/);
  assert.doesNotMatch(plugin, /newClaim/);
  assert.match(metadata, /name: team_memory/);
});
