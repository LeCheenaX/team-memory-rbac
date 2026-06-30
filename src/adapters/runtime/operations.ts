export interface SecretSource {
  get(name: string): string | undefined;
}

export interface DeploymentSecrets {
  libsqlAuthToken?: string;
  qdrantApiKey?: string;
  objectStoreAccessKey?: string;
  objectStoreSecretKey?: string;
}

const secretNamePattern = /(secret|token|password|api[-_]?key|access[-_]?key)/i;

export function loadDeploymentSecrets(source: SecretSource): DeploymentSecrets {
  const optional = (name: string): string | undefined => {
    const value = source.get(name);
    return value === undefined || value.length === 0 ? undefined : value;
  };
  return {
    ...(optional("LIBSQL_AUTH_TOKEN") === undefined
      ? {}
      : { libsqlAuthToken: optional("LIBSQL_AUTH_TOKEN") as string }),
    ...(optional("QDRANT_API_KEY") === undefined
      ? {}
      : { qdrantApiKey: optional("QDRANT_API_KEY") as string }),
    ...(optional("OBJECT_STORE_ACCESS_KEY") === undefined
      ? {}
      : { objectStoreAccessKey: optional("OBJECT_STORE_ACCESS_KEY") as string }),
    ...(optional("OBJECT_STORE_SECRET_KEY") === undefined
      ? {}
      : { objectStoreSecretKey: optional("OBJECT_STORE_SECRET_KEY") as string }),
  };
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        secretNamePattern.test(key) ? "[redacted]" : redactSecrets(item),
      ]),
    );
  }
  return value;
}

export interface OperationalLogRecord {
  level: "info" | "warn" | "error";
  event: string;
  traceId: string;
  auditId?: string;
  metrics?: Record<string, number>;
  details?: unknown;
}

export class StructuredOperationalLogger {
  private readonly sink: (record: OperationalLogRecord) => void;

  constructor(sink: (record: OperationalLogRecord) => void) {
    this.sink = sink;
  }

  emit(record: OperationalLogRecord): void {
    this.sink({
      ...record,
      ...(record.details === undefined
        ? {}
        : { details: redactSecrets(record.details) }),
    });
  }
}

export class FixedWindowRateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(maxRequests: number, windowMs: number, now = () => Date.now()) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.now = now;
  }

  check(key: string): { allowed: boolean; retryAfterMs?: number } {
    const current = this.now();
    const existing = this.buckets.get(key);
    const bucket =
      existing === undefined || existing.resetAt <= current
        ? { count: 0, resetAt: current + this.windowMs }
        : existing;
    bucket.count += 1;
    this.buckets.set(key, bucket);
    if (bucket.count <= this.maxRequests) return { allowed: true };
    return { allowed: false, retryAfterMs: bucket.resetAt - current };
  }
}

export function assertPayloadLimit(payload: string | Uint8Array, maxBytes: number): void {
  const bytes = typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength;
  if (bytes > maxBytes) throw new Error(`payload exceeds ${maxBytes} bytes`);
}

export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage = "operation timed out",
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function retry<T>(
  operation: () => Promise<T>,
  options: { attempts: number; delayMs: number },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < options.attempts) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
    }
  }
  throw lastError;
}

export interface RecoveryDrill {
  dependency: "cas" | "libsql" | "qdrant";
  backup: string;
  restore: string;
  verify: string;
}

export function recoveryDrills(): RecoveryDrill[] {
  return [
    {
      dependency: "cas",
      backup: "snapshot CAS object directory",
      restore: "restore CAS object directory before service start",
      verify: "re-hash sampled objects and compare contentHash",
    },
    {
      dependency: "libsql",
      backup: "export libSQL database snapshot",
      restore: "restore snapshot and run schema validation",
      verify: "replay History and compare branch heads",
    },
    {
      dependency: "qdrant",
      backup: "snapshot Qdrant collections",
      restore: "restore collections from snapshot",
      verify: "rebuild vector projection and compare chunk counts",
    },
  ];
}

export function requiredCiChecks(): string[] {
  return [
    "npm run typecheck",
    "npm test",
    "npm run test:hermes-contract",
    "npm run migrations:validate",
    "npm run smoke:dev",
  ];
}
