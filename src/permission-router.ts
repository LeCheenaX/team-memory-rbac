import type {
  PermissionDecision,
  PermissionRequest,
  PolicyEngine,
} from "./contracts/rbac.ts";

export type AuthorizedMemoryRequest = PermissionRequest & {
  authorization: PermissionDecision & { allowed: true };
};

export interface MemoryAdapter<TResult> {
  execute(request: AuthorizedMemoryRequest): Promise<TResult>;
}

export type PermissionRouteResult<TResult> =
  | {
      decision: PermissionDecision & { allowed: true };
      value: TResult;
    }
  | {
      decision: PermissionDecision & { allowed: false };
    };

export class PermissionRouter<TResult> {
  private readonly policyEngine: PolicyEngine;
  private readonly memoryAdapter: MemoryAdapter<TResult>;

  constructor(
    policyEngine: PolicyEngine,
    memoryAdapter: MemoryAdapter<TResult>,
  ) {
    this.policyEngine = policyEngine;
    this.memoryAdapter = memoryAdapter;
  }

  async execute(
    request: PermissionRequest,
  ): Promise<PermissionRouteResult<TResult>> {
    const decision = await this.policyEngine.decide(request);

    if (!decision.allowed) {
      return {
        decision: decision as PermissionDecision & { allowed: false },
      };
    }

    const authorization = decision as PermissionDecision & { allowed: true };
    const value = await this.memoryAdapter.execute({
      ...request,
      authorization,
    });

    return {
      decision: authorization,
      value,
    };
  }
}
