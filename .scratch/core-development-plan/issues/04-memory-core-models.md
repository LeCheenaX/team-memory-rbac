# 记忆核心模型

Status: ready-for-human

## 目标

实现 L1 / L2 / L3 的权威记忆数据模型。

## 范围

- MemoryEntity
- MemoryEntityBranch
- MemoryRelation
- Resource
- ResourceChunk
- Branch
- Commit
- Snapshot，如有必要
- rootEntityId invariant 校验
- `../DESIGN-NOTES.md` 中的建模约束

## 验收标准

- RootEntity 表示为 `rootEntityId = null` 的 MemoryEntity。
- 普通 MemoryEntity 使用 `rootEntityId = 所属 RootEntity.id`。
- MemoryEntityBranch、MemoryRelation、Resource、ResourceChunk、Branch、Commit、Snapshot 要求非空 rootEntityId。
- `effectiveRootEntityId(entity)` 能解析 `entity.rootEntityId ?? entity.id`。
- relation type 受显式枚举或目录约束。
- 可以通过 `refers_to` 等 relation 表达 L2 / L3 到 L1 的证据回溯。
- 不实现 `MemoryEntityType`；开放语义通过 title、description、tags、extraInfo、relations 表达。
- 不实现 `MemoryCategory`、`CategoryMembership`、`CategorySummary` 作为核心表；类目统一用 MemoryEntity + MemoryRelation 表达。
- `extraInfo` 只描述实体自身，不存 steps、dependsOn、source refs 等关系。
- MemoryRelation 实现 7 种白名单关系及其语义：has、depends_on、relates_to、refers_to、contradicts、supersedes、next_is。

## 优先级

核心。紧跟 RBAC 模型之后实现。

## Comments

### 2026-06-25 Implementation

- 实现 L1 Resource / ResourceChunk / ResourceRevision。
- 实现 L2 MemoryEntityBranch / MemoryRelation。
- 实现 L3 MemoryEntity、`effectiveRootEntityId()` 和 RootEntity 约束。
- 实现 MemoryBranch、MemoryCommit、MemorySnapshot 契约。
- MemoryEntityBranch、MemoryRelation、Resource、ResourceChunk、ResourceRevision、Branch、Commit、Snapshot 均校验非空 rootEntityId。
- MemoryRelation 保持 7 种白名单关系；`refers_to` 已通过实体到 L1 chunk 的证据回溯测试。
- `extraInfo` 继续拒绝 steps、dependsOn、references 等关系信息。
- 未引入 MemoryEntityType、MemoryCategory、CategoryMembership 或 CategorySummary。
- Branch、Commit、ResourceRevision、MemoryOperation 已同步到生成的 JSON Schema。
