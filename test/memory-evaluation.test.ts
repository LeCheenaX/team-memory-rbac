import assert from "node:assert/strict";
import test from "node:test";

import {
  createProbe,
  parseHermesAnswer,
  scoreAnswer,
  selectExamples,
  type HotpotExample,
} from "./evaluation/lib.ts";

function example(id: string): HotpotExample {
  return {
    _id: id,
    answer: `answer-${id}`,
    question: `question-${id}`,
    supporting_facts: [[`title-${id}`, 0]],
    context: Array.from({ length: 10 }, (_, index) => [
      `title-${id}-${index}`,
      [`sentence-${id}-${index}`],
    ]),
    type: "bridge",
    level: "medium",
  };
}

test("selectExamples deterministically chooses unique examples", () => {
  const source = Array.from({ length: 40 }, (_, index) => example(String(index)));
  const first = selectExamples(source, 20, "hotpot-memory-v1");
  const second = selectExamples([...source].reverse(), 20, "hotpot-memory-v1");

  assert.equal(first.length, 20);
  assert.equal(new Set(first.map((item) => item._id)).size, 20);
  assert.deepEqual(first.map((item) => item._id), second.map((item) => item._id));
});

test("createProbe is stable per example and does not expose the answer in the question", () => {
  const probe = createProbe("case-17", "hotpot-memory-v1");

  assert.match(probe.fact, /^Evaluation code for case-17 is [A-Z]+-[0-9]+\.$/);
  assert.equal(probe.question, "What is the evaluation code for case-17?");
  assert.equal(createProbe("case-17", "hotpot-memory-v1").answer, probe.answer);
  assert.ok(!probe.question.includes(probe.answer));
});

test("scoreAnswer implements normalized HotpotQA exact match and token F1", () => {
  assert.deepEqual(scoreAnswer("The Eiffel Tower!", "eiffel tower"), {
    exactMatch: 1,
    f1: 1,
    precision: 1,
    recall: 1,
  });
  assert.deepEqual(scoreAnswer("Paris France", "Paris"), {
    exactMatch: 0,
    f1: 2 / 3,
    precision: 1 / 2,
    recall: 1,
  });
  assert.deepEqual(scoreAnswer("No, it was not", "no"), {
    exactMatch: 0,
    f1: 0,
    precision: 0,
    recall: 0,
  });
});

test("parseHermesAnswer accepts fenced JSON embedded in Hermes output", () => {
  const parsed = parseHermesAnswer(
    'Reasoning complete.\n```json\n{"dataset_answer":"Paris","probe_answer":"KITE-431"}\n```',
  );

  assert.deepEqual(parsed, {
    datasetAnswer: "Paris",
    probeAnswer: "KITE-431",
  });
});
