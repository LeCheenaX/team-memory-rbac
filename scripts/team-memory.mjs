#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
const { loadRuntimeConfig, loadRuntimeConfigFile, TeamMemoryRuntime } = await import("../src/adapters/runtime/development-stack.ts");
const { createMainAgentSession, revokeStoredMainAgentSession } = await import("../src/adapters/local/main-agent-session.ts");
const { clearStoredSession, readStoredSession, writeStoredSession } = await import("../src/adapters/local/session-store.ts");
const { parseRuntimeConfigArgs, resolveConfigPath } = await import("./runtime-config-args.mjs");

const parsedArgs = parseRuntimeConfigArgs(process.argv.slice(2), import.meta.url);
let promptInterface;
let pipedPromptLines;
async function promptLine(message, defaultValue = "") {
  const suffix = defaultValue.length === 0 ? "" : ` [${defaultValue}]`;
  if (!process.stdin.isTTY) {
    process.stdout.write(`${message}${suffix}: `);
    pipedPromptLines ??= readFileSync(0, "utf8").split(/\r?\n/);
    const value = pipedPromptLines.shift() ?? "";
    return value.length === 0 ? defaultValue : value;
  }
  promptInterface ??= createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const value = await promptInterface.question(`${message}${suffix}: `);
  return value.length === 0 ? defaultValue : value;
}

async function readConfigDocument(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function withoutEmpty(value) {
  return value.length === 0 ? undefined : value;
}

async function setupMemory(configPath) {
  const existing = await readConfigDocument(configPath);
  console.log("Team Memory setup: configure the memory runtime before it can be used.");
  console.log("Dev and Production require a real HTTP embedding provider. unitTest may use deterministic fake embeddings.");

  const runtimeMode = await promptLine("运行模式 runtimeMode (unitTest/Dev/Production)", existing.runtimeMode ?? "Dev");
  const providerDefault = runtimeMode === "unitTest" ? "deterministic" : "http";
  const embeddingProvider = await promptLine("embedding provider", existing.embedding?.provider ?? providerDefault);
  const embeddingUrl = await promptLine("embedding URL", existing.embedding?.url ?? "");
  const embeddingModel = await promptLine("embedding model (optional)", existing.embedding?.model ?? "");
  const embeddingName = await promptLine("embedding name (optional)", existing.embedding?.name ?? "");
  const embeddingApiKey = await promptLine("embedding API key (optional)", existing.embedding?.apiKey ?? "");
  const libsqlUrl = await promptLine("libSQL URL", existing.libsql?.url ?? "file:.data/local/team-memory.db");
  const casBackend = await promptLine("CAS backend (filesystem/object_store)", existing.cas?.backend ?? "filesystem");
  const casDirectory = casBackend === "filesystem"
    ? await promptLine("CAS directory", existing.cas?.directory ?? ".data/local/cas")
    : "";
  const objectStoreUrl = casBackend === "object_store"
    ? await promptLine("object store URL", existing.cas?.objectStoreUrl ?? "")
    : "";
  const qdrantUrl = await promptLine("Qdrant URL", existing.qdrant?.url ?? "http://127.0.0.1:6333");
  const qdrantApiKey = await promptLine("Qdrant API key (optional)", existing.qdrant?.apiKey ?? "");
  const recallTopP = Number.parseFloat(await promptLine(
    "recall top-P (0 < p <= 1)",
    String(existing.retrieval?.recallTopP ?? 0.8),
  ));
  const lifecycleExtractionProvider = await promptLine(
    "lifecycle extraction provider (openai_chat/ollama_chat, blank to disable)",
    existing.lifecycleExtraction?.provider ?? "",
  );
  const lifecycleExtractionUrl = lifecycleExtractionProvider.length === 0
    ? ""
    : await promptLine(
        "lifecycle extraction URL",
        existing.lifecycleExtraction?.url ?? "",
      );
  const lifecycleExtractionModel = lifecycleExtractionProvider.length === 0
    ? ""
    : await promptLine(
        "lifecycle extraction model",
        existing.lifecycleExtraction?.model ?? "",
      );
  const lifecycleExtractionApiKey = lifecycleExtractionProvider.length === 0
    ? ""
    : await promptLine(
        "lifecycle extraction API key (optional)",
        existing.lifecycleExtraction?.apiKey ?? "",
      );
  const lifecycleExtractionTimeoutMs = lifecycleExtractionProvider.length === 0
    ? 30_000
    : Number.parseInt(await promptLine(
        "lifecycle extraction timeout milliseconds",
        String(existing.lifecycleExtraction?.timeoutMs ?? 30_000),
      ), 10);

  const candidate = {
    runtimeMode,
    libsql: {
      url: libsqlUrl,
      ...(existing.libsql?.authToken === undefined ? {} : { authToken: existing.libsql.authToken }),
    },
    cas: {
      backend: casBackend,
      ...(casBackend === "filesystem" ? { directory: casDirectory } : { objectStoreUrl }),
    },
    qdrant: {
      url: qdrantUrl,
      ...(withoutEmpty(qdrantApiKey) === undefined ? {} : { apiKey: qdrantApiKey }),
    },
    embedding: {
      provider: embeddingProvider,
      url: embeddingUrl,
      ...(withoutEmpty(embeddingApiKey) === undefined ? {} : { apiKey: embeddingApiKey }),
      ...(withoutEmpty(embeddingModel) === undefined ? {} : { model: embeddingModel }),
      ...(withoutEmpty(embeddingName) === undefined ? {} : { name: embeddingName }),
    },
    retrieval: {
      recallTopP,
    },
    ...(withoutEmpty(lifecycleExtractionProvider) === undefined
      ? {}
      : {
          lifecycleExtraction: {
            provider: lifecycleExtractionProvider,
            url: lifecycleExtractionUrl,
            model: lifecycleExtractionModel,
            ...(withoutEmpty(lifecycleExtractionApiKey) === undefined
              ? {}
              : { apiKey: lifecycleExtractionApiKey }),
            timeoutMs: lifecycleExtractionTimeoutMs,
          },
        }),
  };

  const runtimeConfig = loadRuntimeConfig(candidate);
  console.log("Validating embedding model...");
  await runtimeConfig.embeddings.ready?.();
  const activated = {
    ...candidate,
    activation: {
      status: "active",
      embedding: {
        provider: runtimeConfig.embeddingProviderKind,
        url: runtimeConfig.embeddingProviderUrl,
        ...(runtimeConfig.embeddingProviderModel === undefined ? {} : { model: runtimeConfig.embeddingProviderModel }),
        ...(runtimeConfig.embeddingProviderName === undefined ? {} : { name: runtimeConfig.embeddingProviderName }),
      },
      validatedAt: new Date().toISOString(),
    },
  };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(activated, null, 2)}\n`);
  promptInterface?.close();
  console.log("Embedding model validation passed.");
  console.log("Memory module activated.");
}

if (parsedArgs.args[0] === "setup") {
  await setupMemory(parsedArgs.configPath);
  process.exit(0);
}

let command = parseTeamManagementCommand(parsedArgs.args);

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

  async function loginWithPassword(userId, password) {
    const rootEntityId = nonEmptyEnv("TEAM_MEMORY_ROOT_ENTITY_ID") ?? nonEmptyEnv("BOOTSTRAP_ROOT_ENTITY_ID");
    if (rootEntityId === undefined) throw new Error("TEAM_MEMORY_ROOT_ENTITY_ID or BOOTSTRAP_ROOT_ENTITY_ID must be configured for password login");
    return runtime.rbac.createUserSessionWithPassword({
      id: nonEmptyEnv("TEAM_MEMORY_LOGIN_SESSION_ID") ?? `session:login:${userId}`,
      userId,
      password,
      rootEntityId,
      taskScope: { rootEntityId },
      expiresAt: loginSessionExpiresAt(),
      createdAt: new Date().toISOString(),
    });
  }

  function loginSessionExpiresAt() {
    const expiresAt = nonEmptyEnv("TEAM_MEMORY_SESSION_EXPIRES_AT") ?? nonEmptyEnv("BOOTSTRAP_SESSION_EXPIRES_AT");
    if (expiresAt === undefined) throw new Error("TEAM_MEMORY_SESSION_EXPIRES_AT or BOOTSTRAP_SESSION_EXPIRES_AT must be configured for password login");
    return expiresAt;
  }

  if (isPasswordLogin || isInteractiveLogin) {
    const userId = isPasswordLogin ? command[1] : await promptLine("请输入用户名");
    if (isInteractiveLogin && (await runtime.rbac.getUser(userId)) === undefined) {
      console.error("该用户不存在");
      process.exit(1);
    }
    const password = isPasswordLogin ? command[2] : await promptLine("请输入密码");
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
    const mainAgent = await createMainAgentSession(runtime, {
      userId,
      rootEntityId: identity.rootEntityId,
      expiresAt: loginSessionExpiresAt(),
    });
    await revokeStoredMainAgentSession(runtime, storedSession);
    const sessionFile = await writeStoredSession({
      sessionToken: session.token,
      agentSessionToken: mainAgent.token,
      agentSessionId: mainAgent.sessionId,
      agentId: mainAgent.agentId,
      delegationId: mainAgent.delegationId,
      ...identity,
      savedAt: new Date().toISOString(),
    }, process.env);
    promptInterface?.close();
    if (isInteractiveLogin) {
      console.log("登录成功");
    }
    console.log(JSON.stringify({
      status: "logged_in",
      ...identity,
      mainAgent: {
        agentId: mainAgent.agentId,
        delegationId: mainAgent.delegationId,
        sessionId: mainAgent.sessionId,
      },
      sessionFile,
    }, null, 2));
    process.exit(0);
  }

  const cli = new TeamManagementCli(gateway);
  if (
    command[0] === "members" &&
    command[1] === "create" &&
    command[4].length === 0
  ) {
    const password = await promptLine("New user password");
    if (password.length === 0) {
      throw new Error("new user password is required");
    }
    command = ["members", "create", command[2], command[3], password, command[5]];
  }
  const result = await cli.run(token, command);
  console.log(JSON.stringify(result, null, 2));
} finally {
  runtime.close();
}
