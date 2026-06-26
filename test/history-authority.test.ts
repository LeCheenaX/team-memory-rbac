import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryHistoryAuthority,
  type HistoryAuthority,
} from "../src/index.ts";

test("history authority replays accepted operations as projector events", async () => {
  const history: HistoryAuthority = new InMemoryHistoryAuthority();
  const events = await history.replay({
    rootEntityId: "root:project",
    branchRef: "main",
  });

  assert.deepEqual(events, []);
});
