# 生产运维、安全与恢复基线

Status: ready-for-agent

## What to build

将可运行服务提升到可运维状态：安全配置、密钥管理、可观测性、备份恢复、容量限制和自动化部署。目标是出现依赖故障、权限变更或数据恢复需求时，团队有可执行且经演练的处理路径。

## Acceptance criteria

- [ ] 密钥不进入仓库或日志，并支持部署环境注入/轮换。
- [ ] 关键操作具备结构化日志、metrics、trace 与审计关联 ID。
- [ ] CAS、libSQL 与 Qdrant 有备份、恢复和一致性验证演练。
- [ ] 服务实施合理的限流、payload 限制、超时与重试策略。
- [ ] CI/CD 执行类型检查、集成测试、迁移校验与部署前 smoke test。
- [ ] 运维手册涵盖启动、升级、回滚、依赖故障和数据恢复。

## Blocked by

- Issue 19 - 本地可运行开发栈与服务健康检查
- Issue 20 - 持久化 RBAC、身份认证与管理员 CLI
- Issue 25 - HTTP 与 MCP 服务端授权记忆闭环
- Issue 26 - 持久化 Local Working Replica 与网络 Sync
