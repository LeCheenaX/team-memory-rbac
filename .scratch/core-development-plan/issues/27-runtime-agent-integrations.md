# OpenClaw、Claude Code、Codex 与 Hermes 运行时集成

Status: ready-for-agent

## What to build

让 OpenClaw、Claude Code、Codex 与 Hermes 通过真实服务端使用同一 PrincipalContext、工具权限目录和 Memory SDK。各 runtime 只做薄协议适配，不复制 RBAC、Memory、History 或 Sync 规则。

## Acceptance criteria

- [ ] 四个 runtime 能使用真实 session 完成受授权的 read/search/write。
- [ ] 只读 Agent 看不到且无法绕过写工具；管理员动作不可被 Agent 调用。
- [ ] 子 Agent delegation 受 owner、parent、TaskScope 和撤销状态实时限制。
- [ ] Hermes Python adapter 不保存领域规则，仅处理协议与生命周期。
- [ ] 跨 runtime contract/integration tests 对同一请求得到一致 PermissionDecision 与审计 provenance。

## Blocked by

- Issue 25 - HTTP 与 MCP 服务端授权记忆闭环
- Issue 26 - 持久化 Local Working Replica 与网络 Sync
