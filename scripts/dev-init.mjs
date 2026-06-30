import { bootstrapDevelopment, loadRuntimeConfig, TeamMemoryRuntime } from "../src/adapters/runtime/development-stack.ts";

const config = loadRuntimeConfig(process.env);
const runtime = await TeamMemoryRuntime.create(config);
try {
  const now = new Date();
  const session = await bootstrapDevelopment(runtime, {
    rootEntityId: process.env.DEV_ROOT_ENTITY_ID ?? "root:development",
    userId: process.env.DEV_USER_ID ?? "user:developer",
    displayName: process.env.DEV_USER_NAME ?? "Developer",
    sessionId: process.env.DEV_SESSION_ID ?? "session:developer",
    sessionExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    now: now.toISOString(),
  });
  console.log(JSON.stringify({ rootEntityId: process.env.DEV_ROOT_ENTITY_ID ?? "root:development", userId: process.env.DEV_USER_ID ?? "user:developer", sessionToken: session.token }, null, 2));
} finally {
  runtime.close();
}
