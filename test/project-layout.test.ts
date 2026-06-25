import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";

async function filesUnder(path: string): Promise<string[]> {
  const entries = await readdir(path, {
    recursive: true,
    withFileTypes: true,
  });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => `${entry.parentPath}/${entry.name}`.replaceAll("\\", "/"));
}

test("production directories contain no tests or test support modules", async () => {
  const productionFiles = [
    ...(await filesUnder("src")),
    ...(await filesUnder("adapters")),
  ];
  const misplaced = productionFiles.filter(
    (path) =>
      /(^|\/)(test|tests|testing)(\/|$)/i.test(path) ||
      /(^|\/)(test_|.*\.(test|spec)\.)/i.test(path),
  );

  assert.deepEqual(misplaced, []);
});
