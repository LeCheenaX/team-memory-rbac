import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Hermes Docker entrypoint remains executable on Linux checkouts", async () => {
  const [entrypoint, dockerfile, gitAttributes] = await Promise.all([
    readFile("docker/hermes/entrypoint.sh", "utf8"),
    readFile("docker/hermes/Dockerfile", "utf8"),
    readFile(".gitattributes", "utf8"),
  ]);

  assert.equal(entrypoint.startsWith("#!/usr/bin/env bash\n"), true);
  assert.equal(
    entrypoint.includes("\r\n"),
    false,
    "CRLF line endings make Linux resolve the shebang as `bash\\r`.",
  );
  assert.match(dockerfile, /sed -i 's\/\\r\$\/\/'/);
  assert.match(gitAttributes, /\*\.sh text eol=lf/);
  assert.doesNotMatch(entrypoint, /LIBSQL_URL/);
  assert.doesNotMatch(entrypoint, /CAS_DIRECTORY/);
  assert.match(entrypoint, /TEAM_MEMORY_CONFIG_FILE/);
  assert.match(entrypoint, /\/workspace\/config\/team-memory\.hermes-local\.json/);
  assert.match(entrypoint, /cp \/opt\/team-memory-rbac\/config\/team-memory\.hermes-local\.json "\$TEAM_MEMORY_CONFIG_FILE"/);
  assert.match(entrypoint, /runtime:check/);
  assert.match(entrypoint, /--config "\$TEAM_MEMORY_CONFIG_FILE"/);
  assert.match(entrypoint, /mkdir -p \/workspace\/\.data\/test1-local-hermes\/cas/);
  assert.match(entrypoint, /plugins\/team_memory/);
  assert.match(entrypoint, /load_memory_provider\("team_memory"\)/);
});
