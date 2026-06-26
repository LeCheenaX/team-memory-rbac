# 实现 Local Authorized Working Replica

Status: ready-for-human

## 目标

将当前 `LocalAuthorizedViewStore` 从薄 snapshot store 升级为 Local Authorized Working Replica：本地只保存当前 subject 有读权限的 rootMemoryEntity 子集，但该子集包含可离线工作的 Memory 当前状态和 History operation tree 子集。

## 背景

当前 `src/memory/sync.ts` 的 `LocalAuthorizedViewState` 保存：

- identity
- snapshot
- pendingOperations
- conflicts
- valid

并显式声明不保存 complete commit/operation history。最终方案不是完整云端 mirror，也不是薄 snapshot，而是：

```txt
Local Authorized Working Replica:
  authorized resources
  authorized Qdrant vectors
  authorized Qdrant payload
  authorized memory_relations
  authorized history operation tree subset
  local pending operations
  sync cursor
  conflict metadata
```

## 范围

- 重命名或替换 `LocalAuthorizedViewStore` 为 `LocalAuthorizedWorkingReplica`。
- 本地副本 identity 至少包含：
  - `subjectId`
  - `rootEntityId`
  - `branchRef`
  - `taskScopeHash`
  - `commitWatermark`
  - `permissionWatermark`
- 本地副本持有：
  - Resource CAS 子集
  - Qdrant collections 子集
  - libSQL MemoryRelation 子集
  - libSQL History operation tree 子集
  - pending operations
  - conflict metadata
- 本地所有读取只走 Local Memory。
- pending 写入先进入 Local History，再投影到 Local Memory。

## 验收标准

- 用户没有读权限的 rootMemoryEntity 不会出现在本地 CAS、Qdrant、MemoryRelation 或 History 子集中。
- 本地读取不调用 Cloud。
- 本地 pending 写入无需等待 Cloud 即可检索。
- 权限收窄会清理越权的资源、Qdrant points/payload、relations 和 history subset。
- 删除本地副本后，可以从 Cloud 重新构建到同一授权状态。
- `npm run check` 通过。

## 迁移提示

现有 `InMemoryLocalAuthorizedViewStore` 可以保留为测试 adapter，但接口语义应改为 “working replica”，不再叫 “authorized snapshot view”。

## Comments

### 2026-06-26 Implementation

- 已在提交 `9210b9c` 建立 Local Authorized Working Replica、授权 History 子集与本地 pending 状态。
- `npm run check` 通过。
