# 实现授权子集 Sync 事件协议

Status: ready-for-human

## 目标

实现 Cloud 全量权威和 Local Authorized Working Replica 之间的同步协议。Sync 不拥有长期记忆数据；它只交换 History 事件和 Memory 当前状态变更。

## 背景

当前 `AuthorizedViewSynchronizer` 以 replace / delta snapshot 为中心。最终方案需要同步的是授权子集，包括：

- CAS resources
- Qdrant vectors
- Qdrant payload
- MemoryRelation
- History operation tree subset
- pending operation status
- conflict / resolution events

## 范围

- 定义 Sync event 类型：
  - `history_commit_accepted`
  - `history_conflict_created`
  - `history_resolution_committed`
  - `memory_state_delta`
  - `permission_changed`
  - `replica_rebuild_required`
- 支持 local push：
  - Local History pending operations -> Cloud History
- 支持 local pull：
  - Cloud History accepted/resolution events -> Local History
  - Cloud Memory authorized state changes -> Local Memory stores
- 支持 permissionWatermark：
  - 权限变化后清理或重建本地授权子集
- 支持幂等断点续传。

## 验收标准

- Sync 模块不直接查询 Qdrant、libSQL relation 或 CAS 的内部结构，只通过 Memory / History 接口编排。
- 本地同步中断后可以从最后确认 watermark 继续。
- 无冲突本地 pending 被 Cloud 接受后，本地 pending 标记 resolved。
- 有冲突本地 pending 被 Cloud 捕获为 conflict branch 后，本地仍可保留 pending 可见状态，直到 resolution event。
- resolution event 到达后，Local History 和 Local Memory 按 Cloud 裁决更新。
- 权限变化后，本地越权子集被清理。
- `npm run check` 通过。

## Comments

### 2026-06-26 Implementation

- 已在提交 `9210b9c` 独立 Sync 模块，并实现授权裁剪的 History/Memory 同步事件与 watermark 重建。
- `npm run check` 通过。
