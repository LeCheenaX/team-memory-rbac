# Agent RBAC Memory 设计细节沉淀

Status: ready-for-agent

Source: `D:/Obsidian/01-Projects/Agent RBAC Memory.md`

本文补充 PRD 中容易被实现时遗忘的细节。PRD 负责路线图；本文负责数据结构、建模约束、关系语义和已确认的设计决策。

## 1. 记忆分层

```txt
L3: MemoryEntity
    记忆实体身份层。只表达“这个东西存在”。

L2: MemoryEntityBranch
    记忆实体内容版本层。表达某个实体在某个 branch / commit 下如何描述。

L1: Resource + ResourceChunk + Index
    原始资源层。保存原始文档、代码仓库、对话历史、工具输出、切片、embedding、BM25 索引等。
```

`MemoryEntity` 不是严格树节点。树、链、DAG、工作流、分类、引用、冲突关系都由 `MemoryRelation` 构造。

## 2. 核心建模原则

### 不保留 MemoryEntityType

系统不使用复杂实体类型，例如 `workflow`、`code_function`、`execution_flow`、`approval_rule`、`tool_note`。

原因：

- 类型会快速膨胀。
- LLM 容易误分类。
- schema 难维护。
- 一个实体天然可能有多个身份。

实体语义统一通过以下字段表达：

- `title`
- `description`
- `tags`
- `extraInfo`
- `relations`

### 关系类型少而硬

LLM 不能自由生成关系类型。系统只允许 7 种关系：

```ts
type MemoryRelationType =
  | "has"
  | "depends_on"
  | "relates_to"
  | "refers_to"
  | "contradicts"
  | "supersedes"
  | "next_is"
```

不要引入同义或反向关系，例如：

- `contains`
- `belongs_to`
- `part_of`
- `required_by`
- `cites`
- `derived_from`
- `previous_is`

### extraInfo 只描述实体自身

`extraInfo` 只保存实体自身补充信息，不保存实体之间的关系。

适合放入 `extraInfo`：

```ts
{
  entrypoint: "main.handler",
  trigger: "用户请求",
  exitCondition: "成功返回或异常被捕获"
}
```

不适合放入 `extraInfo`：

```ts
{
  steps: ["step1", "step2"],
  dependsOn: ["toolA", "repoB"]
}
```

步骤、依赖、引用、冲突等必须用 `MemoryRelation` 表达。

## 3. L3: MemoryEntity

`MemoryEntity` 是稳定实体身份，不承载当前内容描述。

```ts
interface MemoryEntity {
  id: string
  rootEntityId: string | null
  status: "active" | "archived" | "tombstoned" | "conflicted"
  currentBranchId?: string
  createdAt: string
  updatedAt: string
}
```

规则：

- RootEntity 的 `rootEntityId = null`。
- 普通 MemoryEntity 的 `rootEntityId = 所属 RootEntity.id`。
- 应用层可用 `effectiveRootEntityId = rootEntityId ?? id`。

## 4. L2: MemoryEntityBranch

`MemoryEntityBranch` 表示某个实体在某个 branch / commit 下的具体内容版本。

```ts
interface MemoryEntityBranch {
  id: string
  entityId: string
  rootEntityId: string
  branchRef: string
  commitId: string
  parentBranchId?: string
  title: string
  description: string
  tags: string[]
  extraInfo?: Record<string, unknown>
  embedding?: number[]
  importance: number
  confidence: number
  createdAt: string
  updatedAt: string
}
```

注意：Obsidian 原文中部分示例把 `rootEntityId` 写成 `root_entiry_id` 或允许 `null`，实现时以最终约定为准：`MemoryEntityBranch.rootEntityId` 必须非空。

## 5. MemoryRelation

`MemoryRelation` 是所有实体、资源、切片关系的统一结构。

```ts
interface MemoryRelation {
  id: string
  rootEntityId: string
  sourceId: string
  sourceKind: "memory_entity" | "resource" | "resource_chunk"
  targetId: string
  targetKind: "memory_entity" | "resource" | "resource_chunk"
  relationType: MemoryRelationType
  role?: string
  ordinal?: number
  required?: boolean
  condition?: Record<string, unknown>
  weight: number
  confidence: number
  branchRef: string
  commitId: string
  status: "active" | "tombstoned" | "conflicted"
  createdAt: string
  updatedAt: string
}
```

实现时 `rootEntityId` 必须非空，用于权限过滤和快速查询。

## 6. 关系语义

### has

`A has B` 表示 A 包含、拥有或由 B 组成。

用于：

- 项目 has 模块
- 类目 has 记忆
- 工作流 has 步骤
- 代码执行流 has 执行阶段

常用字段：

- `role`
- `ordinal`
- `required`

### depends_on

`A depends_on B` 表示 A 的执行、理解或成立依赖 B。

用于：

- 步骤 depends_on 工具说明
- 步骤 depends_on 审批规则
- 代码逻辑 depends_on 架构说明
- 工作流 depends_on 项目约束

### relates_to

`A relates_to B` 表示弱相关关系，不表示依赖、包含、来源或顺序。

它可以近似双向，但数据库中保存一条 canonical edge。

### refers_to

`A refers_to B` 表示 A 引用 B、来源指向 B、可以回溯到 B。

用于替代：

- `derived_from`
- `cites`
- `source_ref`
- `defined_in`

典型场景：

- 记忆实体 refers_to 原始文档
- 记忆实体 refers_to 代码 chunk
- 代码逻辑实体 refers_to 源码片段
- 记忆实体 refers_to 对话历史

### contradicts

`A contradicts B` 表示两个实体内容冲突。

用于：

- 审批规则冲突
- 项目偏好冲突
- 历史事实冲突
- 工具使用限制冲突

它可以近似双向，但数据库中保存一条 canonical edge。

### supersedes

`A supersedes B` 表示 A 取代 B。

方向固定：

```txt
new_entity supersedes old_entity
```

### next_is

`A next_is B` 表示 A 的下一步是 B。

用于：

- 工作流步骤顺序
- 代码执行阶段顺序
- 事件流顺序
- 人工流程顺序

如果线性顺序已经能由 `has(role=step, ordinal=N)` 表达，可以不存 `next_is`。如果存在条件分支，适合使用 `next_is`。

## 7. L1: Resource 与 ResourceChunk

L1 保存原始资源和切片，原始资源不直接原地修改。

```ts
interface Resource {
  id: string
  rootEntityId: string
  sourceType:
    | "document"
    | "conversation"
    | "code_repo"
    | "code_file"
    | "tool_output"
    | "webpage"
    | "ticket"
    | "database_record"
  title: string
  uri?: string
  contentHash: string
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}
```

```ts
interface ResourceChunk {
  id: string
  rootEntityId: string
  resourceId: string
  chunkIndex: number
  text: string
  embedding?: number[]
  bm25DocumentId?: string
  metadata?: {
    headingPath?: string[]
    filePath?: string
    startLine?: number
    endLine?: number
    tokenCount?: number
  }
  createdAt: string
  updatedAt: string
}
```

注意：Obsidian 原文早期 L1 示例没有 `rootEntityId`，实现时以最终约定为准：`Resource` 和 `ResourceChunk` 必须有非空 `rootEntityId`。

## 8. 类目表达

系统不保留单独的 `MemoryCategory` 表。

类目也是 `MemoryEntity`，类目的摘要和描述也存在 `MemoryEntityBranch.description` 中。

类目成员关系使用：

```txt
category_entity --has(role=category_member)--> memory_entity
```

因此不再需要：

- `CategoryMembership`
- `CategorySummary`

如果未来需要物化类目摘要缓存，可以作为 projection，不作为核心数据结构。

## 9. 工作流和代码逻辑流表达

工作流用实体和关系组合表达：

```txt
workflow --has(role=step, ordinal=1, required=true)--> step1
step1 --depends_on(role=tool_note, required=true)--> tool-note
step1 --refers_to(role=source_chunk)--> resource-chunk
step1 --next_is--> step2
```

代码逻辑流也不需要专门类型：

```txt
execution-flow --has(role=execution_step, ordinal=1)--> entrypoint-step
entrypoint-step --refers_to(role=source_code)--> code-chunk
```

“代码逻辑流”“执行流”“项目:代码B”等语义通过 tags 表达。

## 10. 权威存储和索引

云端记忆是完整权威库，包含：

- L1 原始资源
- L1 ResourceChunk
- L1 chunk embedding
- L1 BM25 index
- L2 MemoryEntityBranch
- L2 entity embedding
- L2 MemoryRelation
- L3 MemoryEntity
- Commit / Branch / Snapshot
- RBAC assignments
- Audit logs

推荐存储：

| 数据 | 权威或用途 |
|---|---|
| 原始文件、文档、代码快照、对话历史 | Object Storage，例如 S3 / MinIO |
| Resource / ResourceChunk 元数据 | SQL，例如 PostgreSQL |
| L2 / L3 实体和关系 | SQL，例如 PostgreSQL |
| Commit / Branch / Snapshot | SQL，例如 PostgreSQL |
| L1 chunk embedding | Vector DB，例如 Qdrant / Milvus / pgvector |
| L2 entity embedding | Vector DB，例如 Qdrant / Milvus / pgvector |
| BM25 | OpenSearch / Elasticsearch / Tantivy |
| 图关系查询 | SQL edge table 为权威，Graph DB 可作为投影 |
| 快速权限 / 热点记忆缓存 | Redis，可选 |
| 审计日志 | SQL / append-only log |

Redis 不作为权威记忆库，只做：

- 权限判断结果缓存
- rootEntity 热点查询缓存
- MemoryEntityBranch 热点缓存
- relation expansion 结果缓存
- 本地同步状态缓存
- Agent 会话级短缓存

## 11. 本地授权 View

本地记忆不是权威库，只是云端记忆的授权 View。

本地 View 必须带：

- `rootEntityId`
- `branchRef`
- `commitWatermark`
- `permissionWatermark`
- `taskScope`

本地实现可以替换：

- SQLite / DuckDB
- Kuzu / SQLite edge table
- FAISS / LanceDB / Qdrant local
- Tantivy / SQLite FTS
- 本地文件系统
- Redis local / in-memory cache

## 12. 典型操作约束

### RBAC 操作

- 给 user 分配项目角色只能由管理员或具备 root membership 管理权限的人执行。
- Agent 不允许自动执行“让某人加入项目组”或“分配管理员”。
- 主 Agent 可以管理自己派生出的 subAgent delegation，但不能修改用户长期权限。
- subAgent 降级等价于撤销旧 delegation 再添加新 delegation。

### 记忆写入

- 对话历史先进入 L1 Resource / ResourceChunk，不等于已经进入 L2 / L3。
- L2 新增内容通过新增 MemoryEntityBranch 或 MemoryRelation 表达。
- L3 新增非 RootEntity 时，必须填写所属 RootEntity 的 rootEntityId。
- RootEntity 创建和删除需要管理员权限。
- L1 删除使用 tombstone，不直接物理删除。
- L1 修改创建 ResourceRevision，旧 revision 保留。
- L2 删除 branch / relation 使用 tombstone。
- L2 修改内容新建 branch 或新版本。
- relation 修改等价于 tombstone old relation + create new relation。
- L3 删除 MemoryEntity 使用 tombstone，并 tombstone 相关 relation。
- L3 内容修改主要发生在 L2；L3 本体只改 status、currentBranchId、rootEntityId 特殊迁移等元数据。

### 检索

- 关键词明确时 BM25 优先。
- 语义问题 vector 优先。
- 需要证据时返回 L1 chunk，并通过 `refers_to` 回溯来源。
- 找工作流完整依赖时，先找 workflow entity，再通过 `has` / `depends_on` / `next_is` 展开。
- 找冲突时使用 `contradicts` relation。

## 13. RBAC 数据结构补充

### User

```ts
interface User {
  id: string
  displayName: string
  email?: string
  status: "active" | "disabled"
  createdAt: string
  updatedAt: string
}
```

### AgentIdentity

```ts
interface AgentIdentity {
  id: string
  ownerUserId: string
  agentType:
    | "main_agent"
    | "sub_agent"
    | "tool_agent"
    | "import_agent"
    | "curator_agent"
    | "review_agent"
  displayName: string
  status: "active" | "disabled"
  createdAt: string
  updatedAt: string
}
```

### PermissionConstraint

```ts
interface PermissionConstraint {
  allowedTags?: string[]
  deniedTags?: string[]
  allowedRelationTypes?: MemoryRelationType[]
  deniedRelationTypes?: MemoryRelationType[]
  allowRootEntityMutation?: boolean
  maxRelationExpansionDepth?: number
  requireHumanApproval?: boolean
}
```

### TaskScope

```ts
interface TaskScope {
  rootEntityId: string
  allowedEntityIds?: string[]
  deniedEntityIds?: string[]
  allowedTags?: string[]
  deniedTags?: string[]
  allowedResourceIds?: string[]
  deniedResourceIds?: string[]
  relationExpansionPolicy?: {
    allowedRelationTypes?: MemoryRelationType[]
    maxDepth?: number
    allowRequiredDependencies?: boolean
  }
}
```

### MemoryAction

```ts
type MemoryAction =
  | "read"
  | "search"
  | "traverse_relation"
  | "import_resource"
  | "write_resource_chunk"
  | "index_resource"
  | "write_entity"
  | "write_entity_branch"
  | "write_relation"
  | "tombstone_resource"
  | "tombstone_entity"
  | "tombstone_entity_branch"
  | "tombstone_relation"
  | "commit"
  | "merge"
  | "revert"
  | "review"
  | "approve"
  | "assign_user_role"
  | "revoke_user_role"
  | "create_root_entity"
  | "delete_root_entity"
```

`assign_user_role`、`revoke_user_role`、`create_root_entity`、`delete_root_entity` 属于管理员动作，不允许 Agent 自动执行。
