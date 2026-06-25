import assert from "node:assert/strict";
import test from "node:test";

import {
  assertEntityExtraInfo,
  assertMemoryObjectInvariants,
  MEMORY_RELATION_TYPES,
  isMemoryRelationType,
} from "../src/contracts/memory.ts";

test("memory relations accept only the seven canonical relation types", () => {
  assert.deepEqual(MEMORY_RELATION_TYPES, [
    "has",
    "depends_on",
    "relates_to",
    "refers_to",
    "contradicts",
    "supersedes",
    "next_is",
  ]);

  assert.equal(isMemoryRelationType("has"), true);
  assert.equal(isMemoryRelationType("contains"), false);
  assert.equal(isMemoryRelationType("belongs_to"), false);
});

test("entity extraInfo cannot encode relationships", () => {
  assert.doesNotThrow(() =>
    assertEntityExtraInfo({
      entrypoint: "main.handler",
      trigger: "user_request",
    }),
  );

  assert.throws(
    () =>
      assertEntityExtraInfo({
        steps: ["step-1", "step-2"],
      }),
    /MemoryRelation/,
  );

  assert.throws(
    () =>
      assertEntityExtraInfo({
        dependsOn: ["tool-a"],
      }),
    /MemoryRelation/,
  );
});

test("root entities use a null rootEntityId while all other memory objects require a root", () => {
  assert.doesNotThrow(() =>
    assertMemoryObjectInvariants({
      kind: "memory_entity",
      id: "root-project-a",
      rootEntityId: null,
    }),
  );

  assert.doesNotThrow(() =>
    assertMemoryObjectInvariants({
      kind: "memory_entity",
      id: "entity-workflow",
      rootEntityId: "root-project-a",
    }),
  );

  assert.throws(
    () =>
      assertMemoryObjectInvariants({
        kind: "resource",
        id: "resource-readme",
        rootEntityId: "",
      }),
    /rootEntityId must be a non-empty string/,
  );
});
