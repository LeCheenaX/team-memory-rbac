# 持久化 RBAC 与身份认证基础

Status: complete

## What to build

让服务端持久化 RootEntity 范围内的角色、delegation、session 与审计记录，并从可信 session 生成 PrincipalContext。管理员操作能力作为受保护的服务端接口提供，团队可操作的命令行由 Issue 29 交付。

## Acceptance criteria

- [ ] User、Role、assignment、delegation、session 与审计记录持久化并可在重启后恢复。
- [ ] 服务端提供创建 RootEntity、分配/撤销角色、创建/撤销 delegation 与读取审计的受保护能力。
- [ ] 管理员操作要求管理员身份，Agent 不能借此执行管理员动作。
- [ ] 服务端认证后构造 PrincipalContext，拒绝模型或客户端覆盖 user/agent/root/task scope。
- [ ] 重启、过期 session、撤销 delegation 与跨 root 越权具有集成测试。

## Blocked by

- Issue 19 - 本地可运行开发栈与服务健康检查

## Comments

- Added libSQL-backed users, roles, assignments, delegations, opaque-token sessions, and audit records. Session authentication constructs server-owned subjects/PrincipalContext and re-checks delegation status.
- Protected RootEntity, role, and delegation mutation services reject agent administrator actions; restart, expiry, revocation, and cross-root paths are integration-tested.
