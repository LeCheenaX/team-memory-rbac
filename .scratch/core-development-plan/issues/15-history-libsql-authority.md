# 实现 libSQL History Authority

Status: ready-for-human

## 目标

把现有 `CloudMemoryAuthority` / `InMemoryMemoryAuthority` 中的 commit、operation、conflict 和 resolution 职责迁移为独立 History 模块，并以 libSQL 作为本地和云端同类数据库目标。

## 背景

当前 `src/memory/authority.ts` 同时执行：

- 授权写入校验
- commit / operation 创建
- active view 重放
- revert
- ResourceRevision 维护

当前 `src/memory/cloud-authority.ts` 同时执行：

- cloud conflict detection
- commit records
- outbox events
- active projection read
- conflict branch active view

最终方案要求：

```txt
Cloud History:
  shared authority

Local History:
  local working authority

Memory:
  current authorized working state
```

## 范围

- 新增 `src/history/` 模块。
- 定义 `HistoryAuthority` 接口。
- 定义 `HistoryStore` 接口，目标 adapter 为 libSQL。
- 支持：
  - append operation
  - commit
  - operation tree
  - branch heads
  - conflict keys
  - conflict branches
  - revert / rollback
  - replay
  - resolution commit
  - idempotency via clientMutationId
- 将 `conflictKeysForOperation` 迁入 History 模块。
- 提供 in-memory History adapter 作为测试实现。
- 设计 libSQL schema，但真实 libSQL adapter 可在后续 issue 实现。

## 验收标准

- `src/memory/` 不再导出 Cloud History authority。
- History replay 能生成 Memory projector 可消费的事件序列。
- Cloud History 可以判断 stale write 是否冲突。
- Conflict branch 保存 incoming operation tree，但不改变 target branch head。
- Resolution commit 能引用被裁决的 conflict 和 incoming commit。
- `npm run check` 通过。

## 建议表

```sql
history_commits
history_operations
history_branch_heads
history_conflict_keys
history_conflicts
history_resolutions
history_sync_watermarks
```

表名可调整，但必须体现这是 History 模块，不是 MemoryRelation 或 Qdrant metadata。

## Comments

### 2026-06-26 Implementation

- 已在提交 `600ab33` 引入独立 History 模块、replay seam、in-memory HistoryStore 与 libSQL schema。
- `npm run check` 通过。
