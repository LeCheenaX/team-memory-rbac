import { readFile } from "node:fs/promises";

const schemaFiles = [
  "src/adapters/libsql/rbac-schema.sql",
  "src/adapters/libsql/history-schema.sql",
  "src/adapters/postgres/cloud-memory-schema.sql",
];

for (const file of schemaFiles) {
  const sql = await readFile(file, "utf8");
  if (!/create\s+table/i.test(sql)) {
    throw new Error(`${file} does not define a table migration`);
  }
}

console.log(JSON.stringify({ validated: schemaFiles.length }));
