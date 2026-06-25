# 非核心功能 Backlog

Status: ready-for-human

## What to build

记录有价值但不应阻塞 RBAC、权威写模型、授权检索、云端/本地同步、冲突裁决和 Agent session 身份链路的产品能力。

候选项：

- 管理与冲突裁决 UI
- 审批队列 UI
- 图可视化
- 高级图数据库投影
- 同类记忆聚类摘要
- 遗忘曲线和访问频次评分
- 跨项目共享记忆建议
- analytics / observability dashboard
- 更丰富的导入流水线
- 外部 marketplace 或 plugin packaging

## Acceptance criteria

- [ ] 候选能力不阻塞 Issue 01-11。
- [ ] 每个候选能力在进入开发前拆成独立 tracer-bullet issue。
- [ ] 管理 UI 只能调用 Issue 09 的冲突裁决 API，不自行实现另一套 merge 规则。
- [ ] 图、vector、BM25 和 Redis 相关增强仍遵守“可重建投影而非权威源”的边界。

## Blocked by

- Issue 11 - Agent 工具权限与平台适配
