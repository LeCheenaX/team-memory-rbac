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

## Agent Onboarding

Use a root administrator token to create a production agent identity, delegation, and one-time agent session token:

```sh
TEAM_MEMORY_TOKEN=<admin-token> npm run team -- agents onboard <agent-id> <delegation-id> <session-id> <session-expires-at>
```

The returned `session.token` is the only value OpenClaw, Hermes, Claude Code, Codex, or another host should receive. Hosts must pass it as `TEAM_MEMORY_TOKEN`; they must not provide user, root, agent, or task-scope identity fields in tool payloads.

## OpenClaw

Set `TEAM_MEMORY_URL`, `TEAM_MEMORY_TOKEN`, and `TEAM_MEMORY_MODE`.

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
    "agent-session-token",
)
```

For Hermes memory-provider integration, register `HermesTeamMemoryProvider` at the same provider seam used by mem0-style Hermes memory modules:

```python
from src.adapters.hermes.http_client import HermesTeamMemoryProvider

provider = HermesTeamMemoryProvider.from_http(
    "https://team-memory.example.com",
    "agent-session-token",
)
```

The provider exposes `recall_context`, `search`, and `add`; all calls route through the TypeScript lifecycle gateway. The Python adapter does not duplicate RBAC, History, retrieval, sync, or conflict rules.

## Claude Code

Use `ClaudeCodeTeamMemoryHooks` for automatic lifecycle integration. Configure `UserPromptSubmit` to call `/host/claude_code/recall`, and configure `Stop` and `StopFailure` to call `/host/claude_code/capture`. MCP remains available for explicit tools, but hooks are the primary zero-main-agent-tool-call path.

## MCP Hosts

Codex and other MCP hosts can run:

```sh
TEAM_MEMORY_URL=https://team-memory.example.com TEAM_MEMORY_TOKEN=<agent-token> npm run mcp:stdio
```

Use `adapters/claude-code/.mcp.json` as a project-scoped starting point only when Claude Code also needs explicit Team Memory tools.

## Upgrade And Rollback

Run CI checks before deployment: typecheck, integration tests, Hermes contract tests, migration validation, and smoke validation. For rollback, stop the new service, restore the previous image and environment, then verify `/live`, `/ready`, and an authenticated read.

## Dependency Failure

If libSQL, CAS storage, Qdrant, or the configured object store is unavailable, keep the service running for liveness but treat readiness as failed. Retry transient dependency operations with bounded attempts and structured logs carrying trace and audit IDs.

## Data Recovery

Back up CAS objects, libSQL snapshots, and Qdrant collections. Restore libSQL first, then CAS, then Qdrant; rebuild replaceable projections and verify History replay branch heads, CAS content hashes, and vector chunk counts.
