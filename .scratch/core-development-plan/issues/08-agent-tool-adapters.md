# Agent 与 Tool 适配

Status: ready-for-agent

## 目标

在核心 RBAC 和记忆模块稳定后，接入 Agent runtime 和工具可见性控制。

## 范围

- Memory SDK
- ToolPermissionAdapter
- MainAgent / SubAgent delegation helpers
- TaskPermissionAnalyzer
- OpenClaw TypeScript 原生 memory plugin
- Hermes Python 原生适配器
- Claude Code MCP / HTTP adapter
- Codex MCP / HTTP adapter
- integration tests

## 验收标准

- Agent 可见工具与 effective permissions 一致。
- 只读 Agent 看不到也调不到写工具。
- Curator / Write Agent 只获得明确委派的写权限。
- TaskPermissionAnalyzer 可以报告任务所需权限、缺失权限、能满足任务的角色。
- Agent adapters 只依赖 RBAC / Memory 接口，不依赖存储内部实现。
- Hermes Python 适配器只负责协议、身份和生命周期映射，不复制 RBAC 或 Memory 领域逻辑。
- OpenClaw 插件与 Hermes 适配器通过同一套生成契约通过兼容性测试。

## 优先级

核心模块之后。不是第一阶段实现目标。
