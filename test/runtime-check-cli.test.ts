import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function readRequest(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function httpFixture(responseBody: unknown): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(async (request, response) => {
    await readRequest(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(responseBody));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/embed`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function runRuntimeCheck(configPath: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "scripts/check-runtime-config.mjs", "--config", configPath],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { status, stdout, stderr };
}

test("runtime check fails before setup activation and passes after activation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "team-memory-runtime-check-"));
  const embeddings = await httpFixture({ embedding: [1, 0, 0] });
  const qdrant = await httpFixture({ ok: true });
  const configPath = join(directory, "team-memory.hermes-local.json");
  const baseConfig = {
    runtimeMode: "Dev",
    libsql: { url: `file:${join(directory, "runtime.db")}` },
    cas: { backend: "filesystem", directory: join(directory, "cas") },
    qdrant: { url: qdrant.url },
    embedding: {
      provider: "http",
      url: embeddings.url,
      model: "test-embed",
    },
  };
  try {
    await writeFile(configPath, `${JSON.stringify(baseConfig, null, 2)}\n`);
    const inactive = await runRuntimeCheck(configPath);
    assert.notEqual(inactive.status, 0);
    assert.match(inactive.stderr, /memory module is not active/);

    await writeFile(
      configPath,
      `${JSON.stringify({
        ...baseConfig,
        activation: {
          status: "active",
          embedding: {
            provider: "http",
            url: embeddings.url,
            model: "test-embed",
          },
          validatedAt: "2026-07-11T00:00:00.000Z",
        },
      }, null, 2)}\n`,
    );
    const active = await runRuntimeCheck(configPath);
    assert.equal(active.status, 0, active.stderr);
    assert.match(active.stdout, /runtime config ok/);
  } finally {
    await embeddings.close();
    await qdrant.close();
    await rm(directory, { recursive: true, force: true });
  }
});
