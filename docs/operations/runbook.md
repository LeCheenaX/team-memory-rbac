# Operations Runbook

## Startup

Configure the Team Memory runtime with a JSON config file, not environment
variables. The file must include `runtimeMode` (`unitTest`, `Dev`, or
`Production`), libSQL, CAS, Qdrant, and an explicit embedding provider with a
URL. `unitTest` may use deterministic fake embeddings; `Dev` and `Production`
must use a real HTTP embedding provider. Before starting a `Dev` or
`Production` runtime, run `npm run team -- --config <config-path> setup` and
complete the prompts. Setup validates the configured embedding model and writes
activation only after validation passes. Configs without a current activation
record are intentionally inactive.

Use `cas.backend=filesystem` with `cas.directory` only for a single service
worker or workers sharing the same durable volume. Use `cas.backend=object_store`
with `cas.objectStoreUrl` when multiple service workers may read the same Cloud
Authority state without a shared filesystem. After setup activation, start the
service with `npm run dev:server -- --config <config-path>` or the container
entry point. Secrets such as session tokens may still come from the host
environment; memory runtime settings must not.

Production v1 is one logical Cloud Authority: one authoritative SQL/History source, one authoritative CAS namespace, one authoritative RBAC source, and replaceable Qdrant/BM25/relation projections. Service workers are request handlers, not authorities. Do not run AP multi-master cloud authority replicas in v1.

## Users, Login, And Permissions

Create users and assign their root role from an authenticated administrator
session. A root administrator can create the user and initial role in one
command:

```sh
npm run team -- --config <config-path> members create <user-id> <display-name> <role-id>
```

Team Memory prompts for the new user's password.

Use `role-researcher` for read/search users, `role-curator` for ordinary memory
writers, `role-maintainer` for operational memory maintenance, and
`role-root-admin` only for people who can create users and change assignments.
To grant or change a role later:

```sh
npm run team -- --config <config-path> members assign <assignment-id> <user-id> <role-id>
npm run team -- --config <config-path> members revoke <assignment-id> <user-id>
```

Log in on the device or container that will run the host:

```sh
npm run team -- --config <config-path> login
```

Team Memory prompts for the user name and password. Login writes the local Team
Memory session file. That file contains the human user session for CLI
administration plus an automatically issued main-agent session for host memory
providers such as Hermes. The main agent inherits the
user's effective non-administrator memory permissions for the selected root; it
does not receive user-management, role-assignment, root-create, or root-delete
permissions. Hosts should use the session file by default and should not ask the
operator to copy an agent token after login.

Host memory providers must validate the session before reporting an active
memory module. A provider is active only when the session resolves to an agent
identity and exposes `memory.catalog`. Missing login state, stale sessions,
plain user sessions, or sessions without read/catalog permission must stay
unavailable and prompt the operator to log in or fix the user's role.

Log out by clearing the local session file:

```sh
npm run team -- logout
```

`TEAM_MEMORY_TOKEN` and `ADMIN_TOKEN` remain low-level one-command overrides.
They are useful for automation and server setup, but they bypass the local login
session file and should not be the normal Hermes device-login path.

## Agent And Subagent Sessions

The main host agent is created automatically during login. When a host delegates
work to a subagent, it must use a short-lived agent session whose delegation is a
subset of the owner's permissions and the current task scope. Long-running
service clients may still be pre-provisioned explicitly:

```sh
TEAM_MEMORY_TOKEN=<admin-or-setup-token> npm run team -- --config <config-path> agents onboard <agent-id> <delegation-id> <session-id> <session-expires-at> [read-only|<permissions-json>]
```

Treat explicit `agents onboard` as service setup, not as a required step after a
person logs in. Hosts must not provide user, root, agent, or task-scope identity
fields in tool payloads.

## OpenClaw

Set `TEAM_MEMORY_URL`, `TEAM_MEMORY_MODE`, and either a local session file from
`npm run team -- login` or an explicit service token in `TEAM_MEMORY_TOKEN`.

For parallel memory, use `TEAM_MEMORY_MODE=parallel_native_team_memory` and install `adapters/openclaw/openclaw.plugin.json` as a tool plugin. It exposes `team_memory.search`, `team_memory.write`, `team_memory.import_resource`, and `team_memory.read_resource`.

For full replacement, use `TEAM_MEMORY_MODE=team_memory_replaces_native`, set `plugins.slots.memory` to `team-memory-rbac`, and install the same plugin as the active memory implementation. It exposes OpenClaw-compatible `memory_search`, `memory_get`, `memory_write`, `memory_import`, and `memory_ingest`. The plugin manifest also advertises lifecycle recall and capture through `/host/openclaw/recall` and `/host/openclaw/capture`.

Agents can list the current visible memory directory with `memory.catalog` or
the CLI command `npm run team -- memory catalog`. The catalog returns the
trusted session root, visible `MemoryEntity` identities, current branch
summaries, and available tags. Follow-up retrieval can narrow with stable
filters such as `entityIds`, `tagsAny`, and `tagsNone`; agents must not supply
root identity fields in tool payloads.

## Hermes

Install the Python adapter package or vendor `src.adapters.hermes`. For tool-style calls, construct:

```python
from src.adapters.hermes.http_client import HermesMemoryHttpAdapter

memory = HermesMemoryHttpAdapter(
    "https://team-memory.example.com",
    "main-agent-or-service-session-token",
)
```

For Hermes memory-provider integration, register `HermesTeamMemoryProvider` at the same provider seam used by mem0-style Hermes memory modules:

```python
from src.adapters.hermes.http_client import HermesTeamMemoryProvider

provider = HermesTeamMemoryProvider.from_http(
    "https://team-memory.example.com",
    "main-agent-or-service-session-token",
)
```

The provider exposes `recall_context`, `search`, and `add`; all calls route through the TypeScript lifecycle gateway. The Python adapter does not duplicate RBAC, History, retrieval, sync, or conflict rules.

The Hermes plugin also writes provider-side lifecycle audit entries to
`$TEAM_MEMORY_HERMES_HOOK_LOG`, or to
`$HERMES_HOME/team-memory-hooks.jsonl` by default. Use the
`team_memory_lifecycle_log` tool from Hermes to inspect recent `prefetch`,
`sync_turn`, `on_session_end`, `on_pre_compress`, explicit capture, and failure
events. If this log contains explicit `team_memory_capture` entries but no
`sync_turn` or `on_session_end` entries, Hermes did not invoke the automatic
provider lifecycle hooks for that session.

## Claude Code

Use `ClaudeCodeTeamMemoryHooks` for automatic lifecycle integration. Configure `UserPromptSubmit` to call `/host/claude_code/recall`, and configure `Stop` and `StopFailure` to call `/host/claude_code/capture`. MCP remains available for explicit tools, but hooks are the primary zero-main-agent-tool-call path.

## MCP Hosts

Codex and other MCP hosts can run:

```sh
TEAM_MEMORY_URL=https://team-memory.example.com TEAM_MEMORY_TOKEN=<main-agent-or-service-token> npm run mcp:stdio
```

Use `adapters/claude-code/.mcp.json` as a project-scoped starting point only when Claude Code also needs explicit Team Memory tools.

## Upgrade And Rollback

Run CI checks before deployment: typecheck, integration tests, Hermes contract tests, migration validation, and smoke validation. For rollback, stop the new service, restore the previous image and environment, then verify `/live`, `/ready`, and an authenticated read.

## Dependency Failure

If libSQL, CAS storage, Qdrant, or the configured object store is unavailable, keep the service running for liveness but treat readiness as failed. Retry transient dependency operations with bounded attempts and structured logs carrying trace and audit IDs.

## Data Recovery

Back up CAS objects, libSQL snapshots, and Qdrant collections. Restore libSQL first, then CAS, then Qdrant; rebuild replaceable projections and verify History replay branch heads, CAS content hashes, and vector chunk counts.
