import type {
  PermissionDecision,
  PermissionRequest,
  PolicyEngine,
} from "./contracts/rbac.ts";

export type AuthorizedMemoryRequest<
  TRequest extends PermissionRequest = PermissionRequest,
> = TRequest & {
  authorization: PermissionDecision & { allowed: true };
};

export interface MemoryAdapter<
  TResult,
  TRequest extends PermissionRequest = PermissionRequest,
> {
  execute(request: AuthorizedMemoryRequest<TRequest>): Promise<TResult>;
}

export type PermissionRouteResult<TResult> =
  | {
      decision: PermissionDecision & { allowed: true };
      value: TResult;
    }
  | {
      decision: PermissionDecision & { allowed: false };
    };

export class PermissionRouter<
  TResult,
  TRequest extends PermissionRequest = PermissionRequest,
> {
  private readonly policyEngine: PolicyEngine;
  private readonly memoryAdapter: MemoryAdapter<TResult, TRequest>;

  constructor(
    policyEngine: PolicyEngine,
    memoryAdapter: MemoryAdapter<TResult, TRequest>,
  ) {
    this.policyEngine = policyEngine;
    this.memoryAdapter = memoryAdapter;
  }

  async execute(
    request: TRequest,
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
