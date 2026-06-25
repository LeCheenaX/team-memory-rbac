import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresCloudMemoryAuthority,
  type PostgresPool,
  type PostgresQueryResult,
  type PostgresTransaction,
} from "../adapters/postgres/cloud-memory-authority.ts";
import type {
  PermissionDecision,
  PermissionRequest,
  PolicyEngine,
} from "../src/contracts/rbac.ts";
import { PermissionRouter } from "../src/permission-router.ts";

const timestamp = "2026-06-25T00:00:00.000Z";
const rootEntityId = "root-project-a";

class FakePostgresPool implements PostgresPool {
  private state: unknown;
  transactionCount = 0;

  async transaction<T>(
    callback: (transaction: PostgresTransaction) => Promise<T>,
  ): Promise<T> {
    this.transactionCount += 1;
    const before = structuredClone(this.state);
    const transaction: PostgresTransaction = {
      query: async <Row>(
        sql: string,
        parameters: unknown[] = [],
      ): Promise<PostgresQueryResult<Row>> => {
        if (sql.includes("SELECT payload")) {
          return {
            rows:
              this.state === undefined
                ? []
                : ([{ payload: structuredClone(this.state) }] as Row[]),
          };
        }
        if (
          sql.includes("team_memory_authority_state") &&
          (sql.includes("DO UPDATE") || this.state === undefined)
        ) {
          this.state = JSON.parse(String(parameters[1]));
        }
        return { rows: [] };
      },
    };
    try {
      return await callback(transaction);
    } catch (error) {
      this.state = before;
      throw error;
    }
  }
}

function allow(request: PermissionRequest): PermissionDecision {
  return {
    allowed: true,
    reason: "test",
    subjectId: "user-alice",
    subjectKind: "user",
    rootEntityId: request.rootEntityId,
    action: request.action,
    resourceKind: request.resourceKind,
    matchedRoles: ["role-test"],
    missingActions: [],
    constraints: {},
  };
}

const policy: PolicyEngine = { decide: async (request) => allow(request) };

test("PostgreSQL cloud authority survives restart and preserves idempotency", async () => {
  const pool = new FakePostgresPool();
  const seed = {
    entities: [
      {
        id: rootEntityId,
        rootEntityId: null,
        status: "active" as const,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };
  const first = await PostgresCloudMemoryAuthority.open(
    pool,
    "team-memory",
    seed,
  );
  const router = new PermissionRouter(policy, first);
  const request = {
    subject: { kind: "user" as const, userId: "user-alice" },
    rootEntityId,
    branchRef: "main",
    clientMutationId: "mutation-entity",
    action: "write_entity" as const,
    resourceKind: "memory_entity" as const,
    commit: { id: "commit-entity" },
    operation: {
      kind: "create_entity" as const,
      id: "operation-entity",
      entity: {
        id: "entity-a",
        rootEntityId,
        status: "active" as const,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  };
  await router.execute(request);

  const restarted = await PostgresCloudMemoryAuthority.open(
    pool,
    "team-memory",
    seed,
  );
  assert.deepEqual(
    restarted
      .readActiveView(rootEntityId, "main")
      .entities.map(({ id }) => id),
    [rootEntityId, "entity-a"],
  );
  const restartedRouter = new PermissionRouter(policy, restarted);
  const retry = await restartedRouter.execute(request);
  if (!("value" in retry)) assert.fail("expected idempotent retry");
  assert.equal(retry.value.sequence, 1);
  assert.equal(restarted.commitWatermark(), 1);

  await assert.rejects(
    () =>
      restartedRouter.execute({
        ...request,
        commit: { id: "commit-different" },
      }),
    /clientMutationId was already used for a different command/,
  );
  assert.ok(pool.transactionCount >= 4);
});
