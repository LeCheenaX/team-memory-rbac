import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bootstrapDevelopment,
  TeamMemoryRuntime,
} from "../src/adapters/runtime/development-stack.ts";
import { TeamMemoryGateway } from "../src/adapters/runtime/gateway.ts";
import { unitTestRuntimeConfig } from "./support/runtime-config.ts";

const now = "2026-06-29T00:00:00.000Z";

function entityOperation(name: string, description: string, tags: string[]): Record<string, unknown> {
  return {
    target: "memory_entity",
    op: "create",
    properties: { name, description, tags },
  };
}

function branchOperation(
  entityName: string,
  title: string,
  description: string,
  tags: string[],
): Record<string, unknown> {
  return {
    target: "memory_entity_branch",
    op: "create",
    subject: entityName,
    properties: { name: title, title, description, tags },
  };
}

test("captured Riverfront L2 facts are immediately recallable by exact name", async () => {
  const directory = await mkdtemp(join(tmpdir(), "team-memory-rbac-recall-"));
  const config = unitTestRuntimeConfig({ directory, databaseName: "immediate-recall.db" });
  config.recallTopP = 1;
  const runtime = await TeamMemoryRuntime.create(config);
  const gateway = new TeamMemoryGateway(runtime, {
    retrieval: "active-view",
    projectWrites: false,
  });
  try {
    const admin = await bootstrapDevelopment(runtime, {
      rootEntityId: "root-immediate-recall",
      userId: "user-immediate-recall",
      displayName: "Immediate Recall Admin",
      sessionId: "session-immediate-recall",
      sessionExpiresAt: "2030-01-01T00:00:00.000Z",
      now,
    });
    const tags = ["project:riverfront"];
    const capture = await gateway.writeMemory(admin.token, {
      operations: [
        entityOperation("Riverfront", "Nova CRM customer churn warning pilot.", tags),
        branchOperation("Riverfront", "与 OpenClaw 的关系", "OpenClaw 推送客服工单摘要。", tags),
        branchOperation("Riverfront", "命名约定", "正式项目名是 Riverfront。", tags),
        branchOperation("Riverfront", "发布前检查流程", "发布前先检查流失预警配置。", tags),
      ],
    });
    assert.equal(capture.status, "captured");
    assert.equal(capture.extra.operationsApplied.length, 4);
    assert.equal(capture.extra.systemCompletedOperations.length, 3);

    const search = await gateway.searchMemory(admin.token, {
      query: "Riverfront 流失预警试点 OpenClaw 发布前检查",
      names: ["Riverfront"],
      layer: "L2",
      limit: 10,
    });
    if (!("value" in search)) assert.fail("expected recall value");
    const visibleFacts = search.value.items
      .filter((item) => item.kind === "entity" && item.branch !== undefined)
      .map((item) =>
        item.kind === "entity"
          ? `${item.branch?.title}: ${item.branch?.description}`
          : ""
      );
    assert.deepEqual(visibleFacts.sort(), [
      "与 OpenClaw 的关系: OpenClaw 推送客服工单摘要。",
      "发布前检查流程: 发布前先检查流失预警配置。",
      "命名约定: 正式项目名是 Riverfront。",
    ].sort());
  } finally {
    runtime.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(directory, { recursive: true, force: true, maxRetries: 20 });
  }
});
