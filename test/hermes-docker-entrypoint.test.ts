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
  assert.match(entrypoint, /\$\{LIBSQL_URL#file:\}/);
  assert.match(entrypoint, /mkdir -p "\$\(dirname "\$db_path"\)"/);
  assert.match(entrypoint, /mkdir -p "\$CAS_DIRECTORY"/);
  assert.match(entrypoint, /plugins\/team_memory/);
  assert.match(entrypoint, /load_memory_provider\("team_memory"\)/);
});
