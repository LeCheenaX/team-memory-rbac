import assert from "node:assert/strict";
import test from "node:test";

import { assertMemoryObjectInvariants } from "../src/contracts/memory.ts";
import { contractFixtures } from "./support/contract-fixtures.ts";

test("contract fixtures describe one scoped user and agent memory workflow", () => {
  assert.equal(contractFixtures.user.id, "user-alice");
  assert.equal(contractFixtures.agent.ownerUserId, contractFixtures.user.id);
  assert.equal(
    contractFixtures.assignment.rootEntityId,
    contractFixtures.rootEntity.id,
  );
  assert.equal(
    contractFixtures.taskScope.rootEntityId,
    contractFixtures.rootEntity.id,
  );

  for (const object of contractFixtures.memoryObjects) {
    assert.doesNotThrow(() => assertMemoryObjectInvariants(object));
  }
});
