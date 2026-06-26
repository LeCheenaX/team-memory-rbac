# 建立 Memory 目标存储接口与 Qdrant / libSQL / CAS 适配 seam

Status: ready-for-human

## 目标

把 Memory 当前状态存储接口固定为最终方案：

```txt
Resource:
  CAS / Git-like

ResourceChunk:
  Qdrant vector + payload

MemoryEntityBranch:
  Qdrant vector + payload

MemoryEntity / RootEntity:
  Qdrant vector + payload

MemoryRelation:
  libSQL relation table
```

## 背景

当前检索实现 `src/memory/retrieval.ts` 使用内存数组和 dot product。当前状态对象还把 `embedding` 和 `metadata` 直接放在领域对象上。这可以作为测试 adapter，但不是目标实现形态。

最终形态里，Qdrant payload 是 `ResourceChunk`、`MemoryEntityBranch` 和 `MemoryEntity` 的元数据存储位置；除非字段必须参与非向量事务，否则不单独建 metadata 表。

## 范围

- 定义 `ResourceCas` 接口。
- 定义 `VectorMemoryStore` 接口，覆盖三个 Qdrant collections：
  - `resource_chunks`
  - `memory_entity_branches`
  - `memory_entities`
- 定义 `MemoryRelationStore` 接口，目标实现为 libSQL relation table。
- 定义 Memory projector 写入这些 store 的最小接口。
- 保留 `InMemoryAuthorizedQuerySource` 作为测试 adapter。
- 可以先只新增接口和 in-memory fake，不必须接真实 Qdrant / libSQL 客户端。

## 验收标准

- Memory 当前状态的读写入口不依赖 commit / operation。
- 检索接口可通过 `VectorMemoryStore` 查询 ResourceChunk、MemoryEntityBranch 和 MemoryEntity。
- relation expansion 通过 `MemoryRelationStore` 查询。
- Resource 原文通过 `ResourceCas` 获取，不再假设 Resource text 在 SQL 或 active view payload 内。
- 测试覆盖 Qdrant payload 风格字段：
  - `rootEntityId`
  - `branchRef`
  - `resourceId`
  - `chunkId`
  - `entityId`
  - `entityBranchId`
  - `origin`
  - `pendingId`
  - `status`
- `npm run check` 通过。

## 非目标

- 不要求本 issue 连接真实 Qdrant server。
- 不要求本 issue 连接真实 libSQL server。
- 不引入 Graph DB。

## Comments

### 2026-06-26 Implementation

- 已在提交 `600ab33` 定义 CAS、vector 与 relation store seam，以及 in-memory adapters/projector。
- `npm run check` 通过。
