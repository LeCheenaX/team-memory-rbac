# 记忆版本化写路径

Status: ready-for-human

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

## Comments

### 2026-06-25 Implementation

- 实现 `InMemoryMemoryAuthority`，作为 append-only 权威写模型的首个 adapter。
- `PermissionRouter` 支持保留 Memory command payload；被 RBAC 拒绝的请求不会进入写入模块。
- 每个逻辑写入创建 rootEntityId + branchRef 绑定的 commit 和审计 operation。
- 支持 create entity、entity branch、relation、resource、resource chunk。
- Resource 修改追加 ResourceRevision，旧 revision 保留。
- relation replacement 在同一 commit 中追加 tombstone old + create new 两条 operation。
- entity / branch / relation / resource 删除均使用 tombstone；RootEntity 删除清空整个 active view。
- revert 通过新 commit 移除目标 commit 的 active effect，历史保持可审计；RootEntity 删除也可恢复。
- 写入校验 root ownership、branchRef、引用完整性、重复 ID 和 operation-action-resource 对应关系。
- 失败写入具有原子性，不留下部分 commit 或 operation。
- 对话进入 L1 后不会自动创建 L2 / L3；结构化实体、branch 和 evidence relation 必须单独写入。
- 第一版暂不支持 revert 一个 revert commit。
- `npm run check` 通过：TypeScript typecheck、34 个 Node tests、1 个 Python test。
