import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  TeamManagementCli,
  parseTeamManagementCommand,
} from "../src/adapters/cli/team-management.ts";
import {
  bootstrapDevelopment,
  loadRuntimeConfig,
  TeamMemoryRuntime,
} from "../src/adapters/runtime/development-stack.ts";
import { TeamMemoryGateway } from "../src/adapters/runtime/gateway.ts";
import {
  unitTestRuntimeConfig,
  unitTestRuntimeConfigDocument,
} from "./support/runtime-config.ts";

const now = "2026-06-30T00:00:00.000Z";

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runTeamCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "scripts/team-memory.mjs", ...args],
      {
        cwd: process.cwd(),
        env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`team-memory ${args.join(" ")} timed out after 20000ms`));
    }, 20_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

function runLocalMemoryCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "scripts/local-memory-tool.mjs", ...args],
      {
        cwd: process.cwd(),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`local-memory-tool ${args.join(" ")} timed out after 20000ms`));
    }, 20_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

function envWithoutLogin(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TEAM_MEMORY_TOKEN: "",
    ADMIN_TOKEN: "",
  };
}

async function removeDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") {
    // Fresh libsql/sqlite files can remain locked briefly after CLI subprocesses
    // exit on Windows; recursive deletion can hang the test process.
    return;
  }
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}

async function readRequest(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function embeddingFixture(): Promise<{
  url: string;
  requests: unknown[];
  close(): Promise<void>;
}> {
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    requests.push(JSON.parse((await readRequest(request)).toString()));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ embedding: [1, 0, 0] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/embed`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function assertMissingLoginGuard(): Promise<void> {
  const result = await runTeamCommand(["roots", "list"], envWithoutLogin());

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Team Memory is not logged in/);
  assert.doesNotMatch(result.stderr, /missing bearer token/);
}

async function assertAdminTokenBypassesStoredLoginGuard(): Promise<void> {
  const result = await runTeamCommand("login".split(" "), {
    ...envWithoutLogin(),
    ADMIN_TOKEN: "admin-token-from-compose-run",
  });

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /Team Memory is not logged in/);
}

async function assertGatewayRoutes(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "team-memory-rbac-"));
  const runtime = await TeamMemoryRuntime.create(unitTestRuntimeConfig({
    directory,
    databaseName: "team-cli.db",
  }));
  try {
    const session = await bootstrapDevelopment(runtime, {
      rootEntityId: "root-cli",
      userId: "user-admin-cli",
      displayName: "CLI Admin",
      sessionId: "session-cli-admin",
      sessionExpiresAt: "2030-01-01T00:00:00.000Z",
      now,
    });
    await runtime.rbac.saveUser({
      id: "user-member-cli",
      displayName: "CLI Member",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await runtime.rbac.saveAgent({
      id: "agent-cli",
      ownerUserId: "user-admin-cli",
      agentType: "sub_agent",
      displayName: "CLI Agent",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    const cli = new TeamManagementCli(new TeamMemoryGateway(runtime));
    assert.deepEqual(
      await cli.run(session.token, parseTeamManagementCommand(["roots", "list"])),
      { roots: ["root-cli"] },
    );
    assert.equal(
      ((await cli.run(session.token, ["memory", "catalog"])) as { rootName: string }).rootName,
      "root-cli",
    );

    await cli.run(session.token, [
      "members",
      "assign",
      "assignment-cli-member",
      "user-member-cli",
      "role-researcher",
    ]);
    assert.equal(
      ((await cli.run(session.token, ["members", "list"])) as { assignments: unknown[] }).assignments.length,
      2,
    );

    await cli.run(session.token, [
      "delegations",
      "create",
      "delegation-cli",
      "agent-cli",
      JSON.stringify([
        {
          action: "read",
          resourceKind: "memory_entity",
        },
      ]),
    ]);
    assert.equal(
      ((await cli.run(session.token, ["delegations", "list"])) as { delegations: unknown[] }).delegations.length,
      1,
    );

    await cli.run(
      session.token,
      parseTeamManagementCommand([
        "agents",
        "onboard",
        "agent-cli-readonly",
        "delegation-cli-readonly",
        "session-cli-readonly",
        "2030-01-01T00:00:00.000Z",
        "read-only",
      ]),
    );
    assert.equal(
      ((await cli.run(session.token, ["delegations", "list"])) as { delegations: unknown[] }).delegations.length,
      2,
    );

    assert.deepEqual(await cli.run(session.token, ["conflicts", "list"]), {
      conflicts: [],
    });
    assert.equal(
      ((await cli.run(session.token, ["sync", "status"])) as { rootEntityId: string }).rootEntityId,
      "root-cli",
    );
    assert.equal(
      ((await cli.run(session.token, ["replica", "status"])) as { rootEntityId: string }).rootEntityId,
      "root-cli",
    );

    await new TeamMemoryGateway(runtime).importResource(session.token, {
      clientMutationId: "cli-import-resource",
      resourceId: "resource-cli",
      title: "CLI resource",
      sourceType: "document",
      content: "CLI ingestion creates searchable chunks.",
    });
    const ingestion = await cli.run(
      session.token,
      parseTeamManagementCommand(["resources", "ingest", "resource-cli"]),
    ) as { chunks: unknown[]; rebuiltOnly: boolean };
    assert.equal(ingestion.chunks.length, 1);
    assert.equal(ingestion.rebuiltOnly, true);
    assert.equal(
      ((await cli.run(session.token, ["health"])) as { live: boolean }).live,
      true,
    );

    await cli.run(session.token, ["delegations", "revoke", "delegation-cli", "agent-cli"]);
    await cli.run(session.token, ["members", "revoke", "assignment-cli-member", "user-member-cli"]);
  } finally {
    runtime.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await removeDirectory(directory);
  }
}

async function assertPasswordLoginSessionStore(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "team-memory-rbac-"));
  const config = unitTestRuntimeConfig({
    directory,
    databaseName: "team-cli-login.db",
  });
  const runtime = await TeamMemoryRuntime.create(config);
  try {
    await bootstrapDevelopment(runtime, {
      rootEntityId: "root-cli-login",
      userId: "user-cli-login",
      displayName: "CLI Login",
      sessionId: "session-cli-login-bootstrap",
      sessionExpiresAt: "2030-01-01T00:00:00.000Z",
      now,
    });
    await runtime.rbac.setUserPassword({
      userId: "user-cli-login",
      password: "correct horse battery staple",
      now,
    });
  } finally {
    runtime.close();
  }

  const configPath = join(directory, "team-memory.config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      unitTestRuntimeConfigDocument({
        directory,
        databaseName: "team-cli-login.db",
      }),
      null,
      2,
    ),
  );

  const env = {
    ...process.env,
    TEAM_MEMORY_TOKEN: "",
    ADMIN_TOKEN: "",
    TEAM_MEMORY_SESSION_FILE: join(directory, "session.json"),
    TEAM_MEMORY_ROOT_ENTITY_ID: "root-cli-login",
    TEAM_MEMORY_SESSION_EXPIRES_AT: "2030-01-01T00:00:00.000Z",
  };
  try {
    const login = await runTeamCommand(
      ["--config", configPath, "login", "user-cli-login", "correct horse battery staple"],
      env,
    );
    assert.equal(login.status, 0, login.stderr);
    assert.match(login.stdout, /"status": "logged_in"/);
    assert.doesNotMatch(login.stdout, /sessionToken/);
    assert.match(login.stdout, /"mainAgent"/);

    const storedAfterLogin = JSON.parse(await readFile(env.TEAM_MEMORY_SESSION_FILE, "utf8")) as {
      sessionToken: string;
      agentSessionToken: string;
      agentId: string;
      delegationId: string;
    };
    assert.equal(typeof storedAfterLogin.sessionToken, "string");
    assert.equal(typeof storedAfterLogin.agentSessionToken, "string");
    assert.notEqual(storedAfterLogin.agentSessionToken, storedAfterLogin.sessionToken);
    assert.equal(storedAfterLogin.agentId, "agent:main:user-cli-login");
    assert.equal(storedAfterLogin.delegationId, "delegation:main:user-cli-login:root-cli-login");

    const localTools = await runLocalMemoryCommand(["--config", configPath, "tools"], env);
    assert.equal(localTools.status, 0, localTools.stderr);
    assert.match(localTools.stdout, /memory\.catalog/);
    assert.doesNotMatch(localTools.stdout, /assign_user_role/);

    const relogin = await runTeamCommand(
      ["--config", configPath, "login"],
      env,
      "user-cli-login\ncorrect horse battery staple\n",
    );
    assert.equal(relogin.status, 0, relogin.stderr);
    assert.match(relogin.stdout, /请输入用户名/);
    assert.match(relogin.stdout, /请输入密码/);
    assert.match(relogin.stdout, /登录成功/);

    const oldAgentTools = await runLocalMemoryCommand(["--config", configPath, "tools"], {
      ...env,
      LOCAL_SESSION_TOKEN: storedAfterLogin.agentSessionToken,
    });
    assert.equal(oldAgentTools.status, 1);
    assert.match(oldAgentTools.stderr, /invalid session/);

    const missingUser = await runTeamCommand(
      ["--config", configPath, "login"],
      env,
      "user-cli-missing\n",
    );
    assert.equal(missingUser.status, 1);
    assert.match(missingUser.stderr, /该用户不存在/);

    const badPassword = await runTeamCommand(
      ["--config", configPath, "login"],
      env,
      "user-cli-login\nwrong\n",
    );
    assert.equal(badPassword.status, 1);
    assert.match(badPassword.stderr, /密码错误/);

    const roots = await runTeamCommand(["--config", configPath, "roots", "list"], env);
    assert.equal(roots.status, 0, roots.stderr);
    assert.match(roots.stdout, /root-cli-login/);

    const createReader = await runTeamCommand(
      [
        "--config",
        configPath,
        "members",
        "create",
        "user-cli-reader",
        "Reader",
        "role-researcher",
      ],
      env,
      "reader password\n",
    );
    assert.equal(createReader.status, 0, createReader.stderr);
    assert.match(createReader.stdout, /user-cli-reader/);

    const logout = await runTeamCommand(["logout"], env);
    assert.equal(logout.status, 0, logout.stderr);
    assert.match(logout.stdout, /"status": "logged_out"/);

    const afterLogout = await runTeamCommand(["--config", configPath, "roots", "list"], env);
    assert.equal(afterLogout.status, 1);
    assert.match(afterLogout.stderr, /Team Memory is not logged in/);

    const readerLogin = await runTeamCommand(
      ["--config", configPath, "login", "user-cli-reader", "reader password"],
      env,
    );
    assert.equal(readerLogin.status, 0, readerLogin.stderr);
    assert.match(readerLogin.stdout, /user-cli-reader/);

    const readerRoots = await runTeamCommand(["--config", configPath, "roots", "list"], env);
    assert.equal(readerRoots.status, 0, readerRoots.stderr);
    assert.match(readerRoots.stdout, /root-cli-login/);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await removeDirectory(directory);
  }
}

async function assertSetupActivatesMemoryModule(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "team-memory-rbac-setup-"));
  const embeddings = await embeddingFixture();
  const configPath = join(directory, "team-memory.config.json");
  const inactiveDocument: Parameters<typeof loadRuntimeConfig>[0] = {
    runtimeMode: "Dev",
    libsql: { url: `file:${join(directory, "setup.db")}` },
    cas: { backend: "filesystem", directory: join(directory, "cas") },
    qdrant: { url: "http://127.0.0.1:6333" },
    embedding: { provider: "http", url: embeddings.url, model: "test-embed" },
  };
  await assert.rejects(
    () => TeamMemoryRuntime.create(loadRuntimeConfig(inactiveDocument)),
    /memory module is not active/,
  );

  const setupInput = [
    "Dev",
    "http",
    embeddings.url,
    "test-embed",
    "test-provider",
    "",
    `file:${join(directory, "setup.db")}`,
    "filesystem",
    join(directory, "cas"),
    "http://127.0.0.1:6333",
    "",
  ].join("\n");
  try {
    const setup = await runTeamCommand(["--config", configPath, "setup"], envWithoutLogin(), `${setupInput}\n`);
    assert.equal(setup.status, 0, setup.stderr);
    assert.match(setup.stdout, /Validating embedding model/);
    assert.match(setup.stdout, /Memory module activated/);
    assert.equal(embeddings.requests.length, 1);
    const activated = JSON.parse(await readFile(configPath, "utf8")) as Parameters<typeof loadRuntimeConfig>[0];
    assert.equal(activated.activation?.status, "active");
    assert.deepEqual(activated.activation?.embedding, {
      provider: "http",
      url: embeddings.url,
      model: "test-embed",
      name: "test-provider",
    });

    const runtime = await TeamMemoryRuntime.create(loadRuntimeConfig(activated));
    runtime.close();
    assert.equal(embeddings.requests.length, 2);
  } finally {
    await embeddings.close();
    await removeDirectory(directory);
  }
}

test("team management CLI covers login guards, gateway routing, and stored sessions", async (t) => {
  t.diagnostic("scenario: missing stored login guard");
  await assertMissingLoginGuard();
  t.diagnostic("scenario: ADMIN_TOKEN override reaches runtime config validation");
  await assertAdminTokenBypassesStoredLoginGuard();
  t.diagnostic("scenario: in-process gateway routes management commands");
  await assertGatewayRoutes();
  t.diagnostic("scenario: password login writes and switches stored sessions");
  await assertPasswordLoginSessionStore();
  t.diagnostic("scenario: setup validates embedding and activates memory module");
  await assertSetupActivatesMemoryModule();
});
