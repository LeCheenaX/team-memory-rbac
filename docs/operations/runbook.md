# Operations Runbook

## Startup

Configure `LIBSQL_URL`, `CAS_BACKEND`, `QDRANT_URL`, and optional secret values through the deployment environment. Use `CAS_BACKEND=filesystem` with `CAS_DIRECTORY` only for a single service worker or workers sharing the same durable volume. Use `CAS_BACKEND=object_store` with `OBJECT_STORE_URL` when multiple service workers may read the same Cloud Authority state without a shared filesystem. Start the service with `npm run dev:server` or the container entry point.

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
