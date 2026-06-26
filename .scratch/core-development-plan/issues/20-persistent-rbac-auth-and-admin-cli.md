# 持久化 RBAC 与身份认证基础

Status: ready-for-agent

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
