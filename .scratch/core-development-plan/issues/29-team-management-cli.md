# 团队管理 CLI

Status: ready-for-agent

## What to build

提供 v1 团队操作命令行，不建设管理 UI。管理员能以可审计方式查看系统健康、管理 RootEntity 成员和角色、管理 Agent delegation，并处理冲突 resolution；CLI 只调用服务端授权接口。

## Acceptance criteria

- [ ] CLI 提供登录/身份选择、RootEntity 列表、成员/角色管理和 delegation 管理。
- [ ] CLI 可列出 unresolved conflict，并执行 keep_target、take_incoming、manual_merge resolution。
- [ ] CLI 提供副本/sync 状态与服务 health 诊断命令。
- [ ] 所有变更都经过服务端认证、PermissionRouter 和审计；CLI 不复制领域规则。
- [ ] 不创建 Web 管理 UI；UI 需求继续留在 Issue 12 backlog。

## Blocked by

- Issue 20 - 持久化 RBAC 与身份认证基础
- Issue 25 - HTTP 与 MCP 服务端授权记忆闭环
- Issue 26 - 持久化 Local Working Replica 与网络 Sync
