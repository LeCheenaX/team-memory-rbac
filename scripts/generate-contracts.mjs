import { mkdir, writeFile } from "node:fs/promises";

import { CONTRACT_SCHEMA } from "../src/contracts/schema.ts";

const outputDirectory = new URL("../contracts/", import.meta.url);
const outputFile = new URL(
  "../contracts/team-memory-rbac.schema.json",
  import.meta.url,
);

await mkdir(outputDirectory, { recursive: true });
await writeFile(outputFile, `${JSON.stringify(CONTRACT_SCHEMA, null, 2)}\n`);
