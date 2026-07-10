#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

const { TeamManagementCli, parseTeamManagementCommand } = await import("../src/adapters/cli/team-management.ts");
const { TeamMemoryGateway } = await import("../src/adapters/runtime/gateway.ts");
const { loadRuntimeConfigFile, TeamMemoryRuntime } = await import("../src/adapters/runtime/development-stack.ts");
const { clearStoredSession, readStoredSession, writeStoredSession } = await import("../src/adapters/local/session-store.ts");
const { parseRuntimeConfigArgs, resolveConfigPath } = await import("./runtime-config-args.mjs");

const parsedArgs = parseRuntimeConfigArgs(process.argv.slice(2), import.meta.url);
const command = parseTeamManagementCommand(parsedArgs.args);

function nonEmptyEnv(name) {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

const explicitToken = nonEmptyEnv("TEAM_MEMORY_TOKEN") ?? nonEmptyEnv("ADMIN_TOKEN");
const storedSession = await readStoredSession(process.env);
const token = explicitToken ?? storedSession?.sessionToken;

if (command[0] === "logout") {
  const sessionFile = await clearStoredSession(process.env);
  console.log(JSON.stringify({ status: "logged_out", sessionFile }, null, 2));
  process.exit(0);
}

const isPasswordLogin = command[0] === "login" && command.length === 3;
const isInteractiveLogin = command[0] === "login" && command.length === 1;
if (!isPasswordLogin && !isInteractiveLogin && command[0] !== "health" && (token === undefined || token.length === 0)) {
  console.error(
    "Team Memory is not logged in. Run `team-memory login` or `team-memory login <userId> <password>`, or set TEAM_MEMORY_TOKEN/ADMIN_TOKEN for a one-command override.",
  );
  process.exit(1);
}

const runtime = await TeamMemoryRuntime.create(await loadRuntimeConfigFile(resolveConfigPath(parsedArgs.configPath)));
try {
  const gateway = new TeamMemoryGateway(runtime);

  let promptInterface;
  let pipedPromptLines;
  async function promptLine(message) {
    if (!process.stdin.isTTY) {
      process.stdout.write(message);
      pipedPromptLines ??= readFileSync(0, "utf8").split(/\r?\n/);
      return pipedPromptLines.shift() ?? "";
    }
    promptInterface ??= createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return promptInterface.question(message);
  }

  async function loginWithPassword(userId, password) {
    const rootEntityId = nonEmptyEnv("TEAM_MEMORY_ROOT_ENTITY_ID") ?? nonEmptyEnv("BOOTSTRAP_ROOT_ENTITY_ID");
    const expiresAt = nonEmptyEnv("TEAM_MEMORY_SESSION_EXPIRES_AT") ?? nonEmptyEnv("BOOTSTRAP_SESSION_EXPIRES_AT");
    if (rootEntityId === undefined) throw new Error("TEAM_MEMORY_ROOT_ENTITY_ID or BOOTSTRAP_ROOT_ENTITY_ID must be configured for password login");
    if (expiresAt === undefined) throw new Error("TEAM_MEMORY_SESSION_EXPIRES_AT or BOOTSTRAP_SESSION_EXPIRES_AT must be configured for password login");
    return runtime.rbac.createUserSessionWithPassword({
      id: nonEmptyEnv("TEAM_MEMORY_LOGIN_SESSION_ID") ?? `session:login:${userId}`,
      userId,
      password,
      rootEntityId,
      taskScope: { rootEntityId },
      expiresAt,
      createdAt: new Date().toISOString(),
    });
  }

  if (isPasswordLogin || isInteractiveLogin) {
    const userId = isPasswordLogin ? command[1] : await promptLine("请输入用户名: ");
    if (isInteractiveLogin && (await runtime.rbac.getUser(userId)) === undefined) {
      console.error("该用户不存在");
      process.exit(1);
    }
    const password = isPasswordLogin ? command[2] : await promptLine("请输入密码: ");
    let session;
    try {
      session = await loginWithPassword(userId, password);
    } catch (error) {
      if (error instanceof Error && error.message.includes("invalid user credentials")) {
        console.error("密码错误");
        process.exit(1);
      }
      if (error instanceof Error && error.message.includes("session user is inactive")) {
        console.error("该用户不存在");
        process.exit(1);
      }
      throw error;
    }
    const identity = await gateway.identity(session.token);
    const sessionFile = await writeStoredSession({
      sessionToken: session.token,
      ...identity,
      savedAt: new Date().toISOString(),
    }, process.env);
    promptInterface?.close();
    if (isInteractiveLogin) {
      console.log("登录成功");
    }
    console.log(JSON.stringify({ status: "logged_in", ...identity, sessionFile }, null, 2));
    process.exit(0);
  }

  const cli = new TeamManagementCli(gateway);
  const result = await cli.run(token, command);
  console.log(JSON.stringify(result, null, 2));
} finally {
  runtime.close();
}
