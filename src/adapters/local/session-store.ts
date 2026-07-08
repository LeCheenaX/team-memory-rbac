import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface StoredTeamMemorySession {
  sessionToken: string;
  sessionId: string;
  userId: string;
  rootEntityId: string;
  agentId?: string;
  delegationId?: string;
  savedAt: string;
}

function nonEmpty(environment: Record<string, string | undefined>, name: string): string | undefined {
  const value = environment[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

export function sessionStorePath(environment: Record<string, string | undefined> = process.env): string {
  const explicit = nonEmpty(environment, "TEAM_MEMORY_SESSION_FILE");
  if (explicit !== undefined) return explicit;
  const hermesHome = nonEmpty(environment, "HERMES_HOME");
  if (hermesHome !== undefined) return join(hermesHome, "team-memory-session.json");
  const home = nonEmpty(environment, "HOME") ?? nonEmpty(environment, "USERPROFILE");
  if (home !== undefined) return join(home, ".team-memory", "session.json");
  return join(process.cwd(), ".team-memory-session.json");
}

export async function readStoredSession(
  environment: Record<string, string | undefined> = process.env,
): Promise<StoredTeamMemorySession | undefined> {
  try {
    const parsed = JSON.parse(await readFile(sessionStorePath(environment), "utf8")) as Partial<StoredTeamMemorySession>;
    if (
      typeof parsed.sessionToken !== "string" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.rootEntityId !== "string" ||
      typeof parsed.savedAt !== "string"
    ) {
      return undefined;
    }
    return {
      sessionToken: parsed.sessionToken,
      sessionId: parsed.sessionId,
      userId: parsed.userId,
      rootEntityId: parsed.rootEntityId,
      ...(typeof parsed.agentId === "string" ? { agentId: parsed.agentId } : {}),
      ...(typeof parsed.delegationId === "string" ? { delegationId: parsed.delegationId } : {}),
      savedAt: parsed.savedAt,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeStoredSession(
  session: StoredTeamMemorySession,
  environment: Record<string, string | undefined> = process.env,
): Promise<string> {
  const path = sessionStorePath(environment);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

export async function clearStoredSession(
  environment: Record<string, string | undefined> = process.env,
): Promise<string> {
  const path = sessionStorePath(environment);
  try {
    await unlink(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return path;
}
