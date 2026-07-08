import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CONTRACT_SCHEMA } from "../src/contracts/schema.ts";

test("checked-in JSON Schema matches the TypeScript runtime contract", async () => {
  const generated = JSON.parse(
    await readFile(
      new URL("../contracts/team-memory-rbac.schema.json", import.meta.url),
      "utf8",
    ),
  );

  assert.deepEqual(generated, CONTRACT_SCHEMA);
  assert.deepEqual(
    generated.$defs.MemoryRelationType.enum,
    [
      "has",
      "depends_on",
      "relates_to",
      "refers_to",
      "contradicts",
      "supersedes",
      "next_is",
    ],
  );
  assert.equal(
    generated.$defs.MemoryEntityBranch.required.includes("commitId"),
    false,
  );
  assert.equal(
    generated.$defs.MemoryRelation.required.includes("commitId"),
    false,
  );
  assert.deepEqual(
    generated.$defs.MemoryRelation.properties.sourceKind.enum,
    [
      "memory_entity",
      "memory_entity_branch",
      "resource",
      "resource_chunk",
    ],
  );
  assert.deepEqual(
    generated.$defs.MemoryRelation.properties.targetKind.enum,
    [
      "memory_entity",
      "memory_entity_branch",
      "resource",
      "resource_chunk",
    ],
  );
  assert.deepEqual(
    generated.$defs.AdminMemoryAction.enum,
    [
      "assign_user_role",
      "revoke_user_role",
      "create_root_entity",
      "delete_root_entity",
    ],
  );
  assert.deepEqual(
    generated.$defs.MemoryEntityBranch.properties.extraInfo.propertyNames.not
      .enum,
    [
      "contradicts",
      "dependsOn",
      "depends_on",
      "nextIs",
      "next_is",
      "references",
      "relations",
      "steps",
      "supersedes",
    ],
  );
  for (const definition of [
    "User",
    "AgentIdentity",
    "Permission",
    "Role",
    "UserRootRoleAssignment",
    "AgentDelegation",
    "TaskScope",
    "PermissionRequest",
    "PermissionDecision",
    "MemoryBranch",
    "MemoryCommit",
    "MemoryOperation",
    "ResourceRevision",
  ]) {
    assert.ok(generated.$defs[definition], `missing ${definition} schema`);
  }
});
