# Runtime agent memory integration modes

Status: accepted

OpenClaw, Claude Code, and Hermes must be able to read from and write to Team Memory through trusted agent sessions. Integrations must not rely on model-supplied user identity, and must route all authorization, retrieval, write, history, and sync semantics through the TypeScript core.

## Confirmed host behavior

Claude Code has two native memory surfaces:

- `CLAUDE.md` and rules files are context instructions loaded into sessions.
- Auto memory is Claude-written project memory. It is enabled by default and can be disabled with `autoMemoryEnabled: false` or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.

Claude Code also supports lifecycle hooks such as `UserPromptSubmit`, `Stop`, and `StopFailure`. Team Memory uses these hooks for automatic recall and capture. MCP servers remain useful for explicit tools, including project-scoped `.mcp.json` configuration.

OpenClaw native memory is workspace file-backed:

- `MEMORY.md` for durable long-term facts.
- `memory/YYYY-MM-DD*.md` for daily working notes.
- `DREAMS.md` for dreaming and human review output.

OpenClaw's active memory plugin owns recall, promotion, indexing, and dreaming. Only one plugin owns `plugins.slots.memory` at a time. Companion plugins such as `memory-wiki` can run beside the active memory plugin but do not replace it.

Hermes exposes memory provider/plugin seams, including mem0-style provider modules. The Hermes Team Memory adapter is a Python provider bridge to the TypeScript core and must not duplicate RBAC or memory-domain rules.

## Supported modes

`parallel_native_team_memory`

- Claude Code: keep auto memory and subagent native memory when configured; add Team Memory through hooks for automatic recall/capture and optionally through MCP for explicit tools.
- OpenClaw: keep the current active memory plugin and workspace memory files; add Team Memory as a tool plugin or skill-backed tool surface.
- Hermes: keep existing Hermes memory providers and add Team Memory as a separate provider namespace through the Python provider adapter.

`team_memory_replaces_native`

- Claude Code: disable auto memory with `autoMemoryEnabled: false` or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`; omit subagent `memory` for Team Memory-only agents; use Team Memory hooks as the automatic memory path and optionally expose MCP tools.
- OpenClaw: install Team Memory as the active memory plugin by setting `plugins.slots.memory = "team-memory-rbac"` and exposing compatible recall tools such as `memory_search` and `memory_get`.
- Hermes: Team Memory is the authoritative long-term memory provider. Disable or avoid competing persistent Hermes providers for the same namespace.

## Consequences

The runtime adapter plan must be host-specific. It is not correct to model every host as simply "native memory preserved" or "native memory disabled".

Team Memory write tools remain hidden from read-only agents and direct bypass attempts remain denied by RBAC. Replacement mode changes the host memory path, not the authorization model.

Sources checked before implementation:

- Claude Code memory: https://code.claude.com/docs/en/memory
- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- OpenClaw memory overview: https://docs.openclaw.ai/concepts/memory
- OpenClaw active memory: https://docs.openclaw.ai/concepts/active-memory
- OpenClaw memory plugins: https://docs.openclaw.ai/plugins/memory-lancedb
