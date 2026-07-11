#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

if (!process.execArgv.includes("--experimental-strip-types")) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { env: process.env, stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}

const { TeamMemoryRuntime, loadRuntimeConfigFile } = await import("../src/adapters/runtime/development-stack.ts");
const { BUILT_IN_ROLES } = await import("../src/rbac/catalog.ts");
const { createMainAgentSession, revokeStoredMainAgentSession } = await import("../src/adapters/local/main-agent-session.ts");
const { readStoredSession, writeStoredSession } = await import("../src/adapters/local/session-store.ts");
const { parseRuntimeConfigArgs, resolveConfigPath } = await import("./runtime-config-args.mjs");

const parsedArgs = parseRuntimeConfigArgs(process.argv.slice(2), import.meta.url);
let promptInterface;

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be configured explicitly`);
  }
  return value;
}

async function promptLine(message) {
  if (!process.stdin.isTTY) return undefined;
  promptInterface ??= createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const value = await promptInterface.question(`${message}: `);
  return value.length === 0 ? undefined : value;
}

async function bootstrapPassword() {
  const configured = process.env.BOOTSTRAP_USER_PASSWORD;
  if (configured !== undefined && configured.length > 0) return configured;
  return promptLine("Root admin password");
}

const rootEntityId = required("BOOTSTRAP_ROOT_ENTITY_ID");
const userId = required("BOOTSTRAP_USER_ID");
const displayName = required("BOOTSTRAP_USER_NAME");
const sessionId = required("BOOTSTRAP_SESSION_ID");
const sessionExpiresAt = required("BOOTSTRAP_SESSION_EXPIRES_AT");
const now = process.env.BOOTSTRAP_NOW ?? new Date().toISOString();
const userPassword = await bootstrapPassword();

const runtime = await TeamMemoryRuntime.create(await loadRuntimeConfigFile(resolveConfigPath(parsedArgs.configPath)));
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

  if (userPassword !== undefined && userPassword.length > 0) {
    await runtime.rbac.setUserPassword({ userId, password: userPassword, now });
  }

  let session;
  let duplicateOneShotMessage;
  try {
    session = userPassword !== undefined && userPassword.length > 0
      ? await runtime.rbac.createUserSessionWithPassword({
        id: sessionId,
        userId,
        password: userPassword,
        rootEntityId,
        taskScope: { rootEntityId },
        expiresAt: sessionExpiresAt,
        createdAt: now,
      })
      : await runtime.rbac.createSession({
        id: sessionId,
        userId,
        rootEntityId,
        taskScope: { rootEntityId },
        expiresAt: sessionExpiresAt,
        createdAt: now,
      });
  } catch (error) {
    if (
      userPassword === undefined &&
      error instanceof Error &&
      error.message.includes("UNIQUE constraint failed: rbac_sessions.session_id")
    ) {
      duplicateOneShotMessage = "root admin session already exists. Re-run bootstrap interactively to issue a fresh token for the same bootstrap session, or use the admin token you saved earlier.";
    } else {
      throw error;
    }
  }

  if (duplicateOneShotMessage !== undefined) {
    console.error(duplicateOneShotMessage);
    process.exitCode = 1;
  } else {
    const storedSession = await readStoredSession(process.env);
    const mainAgent = await createMainAgentSession(runtime, {
      userId,
      rootEntityId,
      expiresAt: sessionExpiresAt,
      now,
    });
    await revokeStoredMainAgentSession(runtime, storedSession, now);
    const sessionFile = await writeStoredSession({
      sessionToken: session.token,
      agentSessionToken: mainAgent.token,
      agentSessionId: mainAgent.sessionId,
      agentId: mainAgent.agentId,
      delegationId: mainAgent.delegationId,
      sessionId,
      userId,
      rootEntityId,
      savedAt: new Date().toISOString(),
    }, process.env);
    console.log(JSON.stringify({
      status: "logged_in",
      rootEntityId,
      userId,
      sessionId,
      mainAgent: {
        agentId: mainAgent.agentId,
        delegationId: mainAgent.delegationId,
        sessionId: mainAgent.sessionId,
      },
      sessionFile,
    }, null, 2));
  }
} finally {
  promptInterface?.close();
  runtime.close();
}
