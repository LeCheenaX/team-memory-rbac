#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import http from "node:http";
import https from "node:https";

const qdrantUrl = process.env.QDRANT_URL ?? "http://127.0.0.1:6333";
const healthUrl = new URL("/healthz", qdrantUrl);
const deadlineMs = Number(process.env.CHECK_DEPENDENCY_TIMEOUT_MS ?? 120_000);

function runDockerCompose() {
  const compose = findComposeCommand();
  const result = spawnSync(compose.command, [...compose.args, "up", "-d", "qdrant"], {
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`docker compose exited with status ${result.status}`);
  }
}

function findComposeCommand() {
  const dockerComposePlugin = spawnSync("docker", ["compose", "version"], {
    stdio: "ignore",
  });
  if (dockerComposePlugin.status === 0) {
    return { command: "docker", args: ["compose"] };
  }
  const dockerCompose = spawnSync("docker-compose", ["version"], {
    stdio: "ignore",
  });
  if (dockerCompose.status === 0) {
    return { command: "docker-compose", args: [] };
  }
  throw new Error(
    "Docker Compose is required to run checks. Install either `docker compose` or `docker-compose`.",
  );
}

async function waitForQdrant() {
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < deadlineMs) {
    try {
      const status = await statusCode(healthUrl);
      if (status >= 200 && status < 300) {
        console.log(`Qdrant is ready at ${qdrantUrl}`);
        return;
      }
      lastError = `HTTP ${status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Qdrant did not become ready at ${healthUrl} within ${deadlineMs}ms: ${lastError}`);
}

function statusCode(url) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.get(url, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.setTimeout(2_000, () => {
      request.destroy(new Error("health check timed out"));
    });
    request.on("error", reject);
  });
}

console.log("Starting check dependencies...");
runDockerCompose();
await waitForQdrant();
