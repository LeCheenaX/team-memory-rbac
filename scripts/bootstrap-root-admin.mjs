#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.execArgv.includes("--experimental-strip-types")) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { env: process.env, stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}

const { TeamMemoryRuntime, loadRuntimeConfig } = await import("../src/adapters/runtime/development-stack.ts");
const { BUILT_IN_ROLES } = await import("../src/rbac/catalog.ts");

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be configured explicitly`);
  }
  return value;
}

const rootEntityId = required("BOOTSTRAP_ROOT_ENTITY_ID");
const userId = required("BOOTSTRAP_USER_ID");
const displayName = required("BOOTSTRAP_USER_NAME");
const sessionId = required("BOOTSTRAP_SESSION_ID");
const sessionExpiresAt = required("BOOTSTRAP_SESSION_EXPIRES_AT");
const now = process.env.BOOTSTRAP_NOW ?? new Date().toISOString();

const runtime = await TeamMemoryRuntime.create(loadRuntimeConfig(process.env));
try {
  for (const role of BUILT_IN_ROLES) await runtime.rbac.saveRole(role);
  await runtime.rbac.saveUser({
    id: userId,
    displayName,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  if (runtime.history.readActiveView(rootEntityId, "main").entities.length === 0) {
    await runtime.history.execute({
      subject: { kind: "user", userId },
      rootEntityId,
      branchRef: "main",
      action: "create_root_entity",
      resourceKind: "memory_entity",
      clientMutationId: `bootstrap-root:${rootEntityId}`,
      commit: {
        id: `bootstrap-root-commit:${rootEntityId}`,
        message: "Bootstrap root administrator",
      },
      operation: {
        kind: "create_entity",
        id: `bootstrap-root-operation:${rootEntityId}`,
        entity: {
          id: rootEntityId,
          rootEntityId: null,
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      },
      authorization: {
        allowed: true,
        reason: "manual_production_bootstrap",
        subjectId: userId,
        subjectKind: "user",
        rootEntityId,
        action: "create_root_entity",
        resourceKind: "memory_entity",
        matchedRoles: ["role-root-admin"],
        missingActions: [],
        constraints: { allowRootEntityMutation: true },
      },
    });
  }

  await runtime.rbac.saveAssignment({
    id: `root-owner:${userId}:${rootEntityId}`,
    userId,
    rootEntityId,
    roleId: "role-root-admin",
    assignedBy: userId,
    assignedAt: now,
    status: "active",
  });

  const session = await runtime.rbac.createSession({
    id: sessionId,
    userId,
    rootEntityId,
    taskScope: { rootEntityId },
    expiresAt: sessionExpiresAt,
    createdAt: now,
  });

  console.log(JSON.stringify({
    rootEntityId,
    userId,
    sessionId,
    sessionToken: session.token,
  }, null, 2));
} finally {
  runtime.close();
}
