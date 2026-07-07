import type { Permission } from "../../contracts/rbac.ts";
import type { TeamMemoryGateway } from "../runtime/gateway.ts";

export type TeamManagementCommand =
  | ["login"]
  | ["roots", "list"]
  | ["members", "list"]
  | ["members", "assign", string, string, string]
  | ["members", "revoke", string, string]
  | ["delegations", "list"]
  | ["delegations", "create", string, string, string]
  | ["delegations", "revoke", string, string]
  | ["agents", "onboard", string, string, string, string, string?]
  | ["resources", "ingest", string, string?]
  | ["conflicts", "list"]
  | ["conflicts", "resolve", string, "keep_target" | "take_incoming" | "manual_merge"]
  | ["replica", "status"]
  | ["sync", "status"]
  | ["health"];

export class TeamManagementCli {
  private readonly gateway: TeamMemoryGateway;

  constructor(gateway: TeamMemoryGateway) {
    this.gateway = gateway;
  }

  async run(token: string | undefined, command: TeamManagementCommand): Promise<unknown> {
    switch (command[0]) {
      case "login":
        return this.gateway.identity(token);
      case "roots":
        return this.gateway.listRoots(token);
      case "members":
        return this.members(token, command);
      case "delegations":
        return this.delegations(token, command);
      case "agents":
        return this.gateway.onboardAgent(token, {
          agentId: command[2],
          delegationId: command[3],
          sessionId: command[4],
          sessionExpiresAt: command[5],
          ...(command[6] === undefined
            ? {}
            : { permissions: this.parsePermissions(command[6]) }),
        });
      case "resources":
        return this.gateway.ingestResource(token, command[2], {
          clientMutationId: command[3] ?? `cli-ingest:${command[2]}`,
        });
      case "conflicts":
        return this.conflicts(token, command);
      case "replica":
      case "sync":
        return this.gateway.syncStatus(token);
      case "health":
        return this.gateway.health();
    }
  }

  private members(token: string | undefined, command: Extract<TeamManagementCommand, ["members", ...string[]]>): Promise<unknown> {
    if (command[1] === "list") return this.gateway.listMembers(token);
    if (command[1] === "assign") {
      return this.gateway.assignRole(token, {
        assignmentId: command[2],
        userId: command[3],
        roleId: command[4],
      });
    }
    return this.gateway.revokeRole(token, {
      assignmentId: command[2],
      userId: command[3],
    });
  }

  private delegations(token: string | undefined, command: Extract<TeamManagementCommand, ["delegations", ...string[]]>): Promise<unknown> {
    if (command[1] === "list") return this.gateway.listDelegations(token);
    if (command[1] === "create") {
      return this.gateway.createDelegation(token, {
        delegationId: command[2],
        agentId: command[3],
        permissions: this.parsePermissions(command[4]),
      });
    }
    return this.gateway.revokeDelegation(token, {
      delegationId: command[2],
      agentId: command[3],
    });
  }

  private conflicts(token: string | undefined, command: Extract<TeamManagementCommand, ["conflicts", ...string[]]>): Promise<unknown> {
    if (command[1] === "list") return this.gateway.listConflicts(token, {});
    return this.gateway.resolveConflict(token, {
      clientMutationId: `cli-resolution:${command[2]}`,
      commit: { id: `cli-resolution:${command[2]}` },
      conflictIds: [command[2]],
      resolutionKind: command[3],
    });
  }

  private parsePermissions(serialized: string): Permission[] {
    if (serialized === "read-only") {
      return [
        {
          action: "read",
          resourceKind: "memory_entity",
          constraints: { allowRootEntityMutation: true },
        },
        {
          action: "search",
          resourceKind: "memory_entity",
          constraints: { allowRootEntityMutation: true },
        },
      ];
    }
    const parsed = JSON.parse(serialized) as Permission[];
    if (!Array.isArray(parsed)) throw new Error("permissions must be a JSON array");
    return parsed;
  }
}

export function parseTeamManagementCommand(args: string[]): TeamManagementCommand {
  const [area, action, first, second, third] = args;
  if (area === "login") return ["login"];
  if (area === "roots" && action === "list") return ["roots", "list"];
  if (area === "members" && action === "list") return ["members", "list"];
  if (area === "members" && action === "assign" && first !== undefined && second !== undefined && third !== undefined) {
    return ["members", "assign", first, second, third];
  }
  if (area === "members" && action === "revoke" && first !== undefined && second !== undefined) {
    return ["members", "revoke", first, second];
  }
  if (area === "delegations" && action === "list") return ["delegations", "list"];
  if (area === "delegations" && action === "create" && first !== undefined && second !== undefined && third !== undefined) {
    return ["delegations", "create", first, second, third];
  }
  if (area === "delegations" && action === "revoke" && first !== undefined && second !== undefined) {
    return ["delegations", "revoke", first, second];
  }
  if (
    area === "agents" &&
    action === "onboard" &&
    first !== undefined &&
    second !== undefined &&
    third !== undefined &&
    args[5] !== undefined
  ) {
    return args[6] === undefined
      ? ["agents", "onboard", first, second, third, args[5]]
      : ["agents", "onboard", first, second, third, args[5], args[6]];
  }
  if (area === "resources" && action === "ingest" && first !== undefined) {
    return second === undefined
      ? ["resources", "ingest", first]
      : ["resources", "ingest", first, second];
  }
  if (area === "conflicts" && action === "list") return ["conflicts", "list"];
  if (
    area === "conflicts" &&
    action === "resolve" &&
    first !== undefined &&
    (second === "keep_target" || second === "take_incoming" || second === "manual_merge")
  ) {
    return ["conflicts", "resolve", first, second];
  }
  if (area === "replica" && action === "status") return ["replica", "status"];
  if (area === "sync" && action === "status") return ["sync", "status"];
  if (area === "health") return ["health"];
  throw new Error(`unknown team-memory command: ${args.join(" ")}`);
}
