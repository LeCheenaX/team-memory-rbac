# 记忆版本化写路径

Status: ready-for-agent

## 目标

实现基于 operation 的记忆写入，支持 commit、tombstone、revision 和 rollback。

## 范围

- MemoryOperation model
- L1 / L2 / L3 create、update、tombstone 操作
- commit creation
- branchRef handling
- Resource revision behavior
- Relation replacement behavior
- rollback / revert
- 审计字段

## 验收标准

- 写入只能来自已授权的 routed request。
- 原始资源不被原地覆盖，修改会产生 revision。
- 删除默认使用 tombstone。
- relation 修改表现为 tombstone old relation + create new relation。
- commit 绑定 rootEntityId。
- revert 能把错误写入从 active view 移除，同时保留历史。
- 测试覆盖增加对话历史、增加 L2 branch、增加 relation、创建非 root entity、tombstone、revert。
- 对话历史进入 L1 Resource / ResourceChunk 后，不自动视为已经进入 L2 / L3；结构化抽取是后续独立操作。
- L3 内容修改优先通过 L2 MemoryEntityBranch 表达；L3 本体只承载稳定身份和少量元数据。

## 优先级

核心。这是 RBAC 之后的第二块地基。
