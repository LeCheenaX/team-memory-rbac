# HTTP 与 MCP 服务端授权记忆闭环

Status: complete

## What to build

将可信 session、PermissionRouter、Memory、History 和 Retrieval 组合为可供外部客户端使用的 HTTP 与 MCP 服务。每个读写、检索、replay 和 conflict resolution 请求都从认证上下文获得 PrincipalContext。

## Acceptance criteria

- [ ] HTTP 与 MCP 提供等价的 authenticated read、write、search、history 与 resolution 能力。
- [ ] 所有 endpoint/tool 在进入领域模块前验证 session 与 PermissionDecision。
- [ ] 请求 payload 不允许覆盖 userId、ownerUserId、agentId、rootEntityId 或 TaskScope。
- [ ] 标准化错误区分认证失败、权限拒绝、冲突、校验失败和依赖不可用。
- [ ] 可用真实服务端集成测试验证一个用户、只读 Agent 与写入 Agent 的完整路径。

## Implementation notes

- Added `TeamMemoryGateway` as the shared authenticated service boundary for HTTP and MCP-style tools.
- Extended the HTTP server with memory write, search, history, conflict, resolution, and sync pull routes while preserving existing resource routes.
- Added `McpTeamMemoryAdapter` so MCP tools call the same gateway methods as HTTP instead of duplicating authorization logic.
- Standardized gateway errors into authentication, permission, conflict, validation, dependency, and not-found categories.
- Covered user, read-only agent, and write agent flows in `test/http-mcp-gateway.test.ts`, including payload identity override rejection.

## Blocked by

- Issue 20 - 持久化 RBAC、身份认证与管理员 CLI
- Issue 21 - libSQL History Authority 生产适配器
- Issue 23 - Qdrant 与 libSQL Relation Store 授权检索闭环
- Issue 24 - 文档摄取、切块、Embedding 与 BM25 管道
