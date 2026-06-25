# Agent 工具权限与平台适配

Status: ready-for-human

## What to build

在 PrincipalContext、RBAC 和 Memory 接口之上实现 Memory SDK、ToolPermissionAdapter、MainAgent/SubAgent delegation helpers、TaskPermissionAnalyzer，以及 OpenClaw、Hermes、Claude Code 和 Codex 的薄适配器。

工具是否可见必须与 effective permissions 一致，但工具隐藏只用于减少误用；每次工具执行仍须经过服务端 PermissionRouter。

## Acceptance criteria

- [ ] Agent 可见工具集合由 session PrincipalContext 下的 effective permissions 生成。
- [ ] 只读 Agent 看不到写工具；即使绕过工具目录直接调用写 endpoint，也会被 PermissionRouter 拒绝。
- [ ] Curator/Write Agent 只获得明确 delegation 和 TaskScope 允许的写工具。
- [ ] MainAgent 派生 SubAgent 时，新 delegation 不超过 owner、parent delegation 和 TaskScope 的交集。
- [ ] Agent 永远看不到或执行不了管理员级动作。
- [ ] TaskPermissionAnalyzer 能报告任务所需权限、当前已授予权限、缺失权限、可满足任务的角色和是否需要人工批准。
- [ ] TaskPermissionAnalyzer 不会自动授予、扩大或持久化权限。
- [ ] 平台适配器只依赖 PrincipalContext、RBAC、Memory SDK 和生成契约，不依赖 PostgreSQL、SQLite、Redis 或索引实现。
- [ ] Hermes Python 适配器只负责协议、session 身份和生命周期映射，不复制 RBAC 或 Memory 领域规则。
- [ ] OpenClaw、Hermes、MCP/HTTP 适配器对同一身份和请求产生兼容的 PermissionDecision。
- [ ] 适配器契约测试覆盖 read-only agent、curator、subagent 降权、delegation 撤销和直接 endpoint 绕过。

## Blocked by

- Issue 09 - 本地 Pending Overlay 与人工冲突裁决闭环
- Issue 10 - Agent Session 身份上下文

## Comments

### 2026-06-25 Implementation

- 实现 `SessionMemorySdk`，所有 Agent 调用先解析 session，再通过 PolicyEngine 获取实时 PermissionDecision。
- 实现 `ToolPermissionAdapter`；工具目录由 effective permissions 生成，但每次 invoke 仍重新授权。
- 工具 schema 和运行时输入都拒绝 userId、ownerUserId、agentId、rootEntityId、TaskScope 等身份字段。
- 只读 Agent 不显示写工具；直接绕过工具目录调用写工具仍被拒绝。
- Agent 管理员动作永远不进入可见工具目录。
- 实现 `createSubAgentDelegation`，requested permission 必须同时是 owner、parent 和 TaskScope 的子集，并禁止管理员权限。
- 实现 `TaskPermissionAnalyzer`，报告 required、granted、missing、satisfying roles 和 human approval，不修改 RBAC。
- 平台 adapter 位于顶层 `adapters/`，只委托 PrincipalContext 和 ToolPermissionAdapter，不依赖存储实现。
- HTTP、MCP、OpenClaw、Hermes、Claude Code 和 Codex 对相同 session/tool 调用返回兼容 PermissionDecision。
- 测试覆盖 researcher、curator、直接绕过、delegation 撤销、subagent 降权、权限分析和平台兼容。
