# Team Memory RBAC 项目开发计划

Status: ready-for-agent

## 目标

构建一个面向多用户、多 Agent 的共享记忆系统。系统必须通过 RBAC 隔离用户、Agent、项目和任务权限，避免无权限读取、越权写入、调研 Agent 污染知识库，以及项目切换时上下文丢失。

开发优先级固定为：

1. RBAC 模块
2. Memory 模块
3. History 模块
4. Sync 模块
5. Agent / Tool 适配、UI 和其他非核心能力

在 RBAC、Memory、History 和 Sync 的核心边界稳定前，不优先开发 UI、图可视化、高级摘要、外部 Agent 深度集成等外围能力。

## 架构基线

RBAC、Memory、History 和 Sync 是独立模块，通过接口通信。

### 开发语言与运行时

- RBAC、Memory、持久化适配器、HTTP 服务和 MCP Server 统一使用 TypeScript。
- OpenClaw 使用 TypeScript 原生插件接入。
- Claude Code 和 Codex 通过 MCP / HTTP 接入 TypeScript 核心。
- Hermes 原生适配器使用 Python，但只能作为薄适配器调用核心接口，不得复制权限判断或记忆领域规则。
- 跨语言契约使用 JSON Schema / OpenAPI 等语言中立格式生成和校验。

该决策记录在 `docs/adr/0001-typescript-core-python-hermes-adapter.md`。

RBAC 只回答：

```txt
某个主体是否能在某个 rootEntityId 和 task scope 下，
对某类资源执行某个动作？
```

Memory 只回答：

```txt
在请求已经被授权的前提下，
如何读、写和检索当前可用的记忆状态？
```

History 只回答：

```txt
在请求已经被授权的前提下，
这些记忆状态是如何产生、撤回、回放、冲突、裁决和合并的？
```

Sync 只回答：

```txt
如何在 Cloud 全量权威和 Local 授权工作副本之间交换 History 事件与 Memory 状态变更？
```

四者之间通过 `PermissionRouter`、`MemoryAdapter` 和专用模块接口连接。Memory 不直接处理角色分配、审计历史或同步协议；RBAC 不理解记忆内容，只识别 `subject`、`rootEntityId`、`action`、`resourceKind`、`tags`、`taskScope` 等权限元数据。

## 核心需求

详细数据结构、关系语义、存储约束和已确认的建模决策沉淀在：

- `DESIGN-NOTES.md`

实现 PRD 和 issues 时必须同时遵守该文件。

### 1. Scoped RBAC

用户权限不是全局能力，而是绑定到 RootEntity 范围：

```txt
User + rootEntityId + Role = scoped effective permission
```

Agent 只能继承用户权限的子集：

```txt
AgentEffectivePermission =
  UserPermissionAtRoot
  intersect AgentDelegation
  intersect TaskScope
```

第一版必须支持：

- User
- AgentIdentity
- 内置 Role
- 自定义 Role
- UserRootRoleAssignment
- AgentDelegation
- TaskScope
- PermissionDecision
- 权限拒绝原因和缺失权限报告
- 角色分配、委派、撤销的审计记录

管理员级动作不能由 Agent 自动执行：

- 把 user 加入项目 / RootEntity
- 把 user 移出项目 / RootEntity
- 分配管理员角色
- 创建 RootEntity
- 删除 RootEntity

### 2. Memory 分层模型

记忆模块分三层：

```txt
L3: MemoryEntity
    稳定实体身份。RootEntity 是特殊的 MemoryEntity。

L2: MemoryEntityBranch + MemoryRelation
    实体内容版本和实体之间的关系。

L1: Resource + ResourceChunk
    原始证据、文档、对话、代码、工具输出和切片。
```

`rootEntityId` 规则：

```txt
RootEntity:
  MemoryEntity.rootEntityId = null

普通 MemoryEntity:
  MemoryEntity.rootEntityId = 所属 RootEntity.id

其他记忆对象:
  rootEntityId 必须非空
```

Memory 模块只保存当前可检索、可读写状态，不保存操作历史本身。当前状态存储定案为：

```txt
Resource:
  CAS / Git-like 原始资源存储

ResourceChunk:
  Qdrant vector + Qdrant payload metadata

MemoryEntityBranch:
  Qdrant vector + Qdrant payload metadata

MemoryEntity / RootEntity:
  Qdrant vector + Qdrant payload metadata

MemoryRelation:
  libSQL relation table
```

Qdrant payload 是 ResourceChunk、MemoryEntityBranch 和 MemoryEntity 的元数据存储位置。除非某字段必须参与非向量事务，或 Qdrant payload 无法承载，否则不再为这些对象单独建立 metadata 表。

Cloud Memory 保存所有 rootMemoryEntity 的当前状态。Local Memory 保存当前 subject / task scope 有读权限的 rootMemoryEntity 子集，是本地授权工作副本的当前状态层。

### 3. History / 审计写入

记忆写入必须通过 History operation 和 commit 表达。破坏性修改不直接物理删除，默认使用 tombstone 或 revision。

History 模块不属于 Memory 模块。它负责操作审计、撤回、回放、冲突键、分支头、resolution 和合并。

第一版必须支持：

- append-only history operation
- rootEntityId 级 commit
- branchRef
- tombstone
- rollback / revert
- replay
- conflict key
- conflict branch
- resolution commit
- 写入主体审计，包括 user / agent

权威关系：

```txt
Cloud History 是 shared authority。
Local History 是 local working authority。
Local Memory 是 current authorized working state。
```

Cloud History 保存全量 rootMemoryEntity 的操作树。Local History 只保存当前 subject 有读权限的 rootMemoryEntity 子集、local pending operations、同步游标和少量 conflict metadata。

### 4. 授权检索

第一版检索能力以“权限正确”为第一目标，而不是以“召回最强”为第一目标。

必须支持：

- rootEntityId filter
- TaskScope filter
- tag filter
- L1 文本 / BM25 检索接口
- L1 向量检索接口
- L2 / L3 entity 检索
- relation expansion，并受 maxDepth 限制
- L2 / L3 结果回溯到 L1 evidence

图数据库投影、遗忘曲线、聚类摘要、跨项目推荐放到后续阶段。

## 第一版不做

- 任意实体级长期 ACL
- 图数据库作为权威存储
- 完整 UI
- 跨组织共享
- Agent 自动执行管理员动作
- 高级记忆衰减、聚类、摘要再生成
- 外部 Agent 平台的完整生态适配

实体级控制第一版只通过 `TaskScope` 临时收窄实现。如果某个模块长期需要独立授权，把它提升为新的 RootEntity。

## 里程碑

### Milestone 0: 架构与接口契约

目标：先把模块边界钉住，避免后续 RBAC 和 Memory 互相污染。

交付物：

- 领域词汇和架构说明
- RBAC interface contracts
- Memory interface contracts
- PermissionRouter contract
- MemoryAdapter contract
- 用户、RootEntity、角色、Agent、TaskScope、记忆对象 fixtures
- 请求从 Agent 到 RBAC 再到 Memory 的 contract tests

完成标准：

- RBAC 实现不依赖 Memory 存储内部细节
- Memory 实现不依赖 RBAC assignment 内部细节
- contract tests 能描述完整授权管线

### Milestone 1: RBAC Core

目标：先做权限系统，再开放大范围记忆写入。

交付物：

- User / AgentIdentity / Role / Permission
- UserRootRoleAssignment
- AgentDelegation
- TaskScope
- PolicyEngine
- PermissionRouter skeleton
- permission cache interface
- audit log interface
- 内置角色目录和自定义角色校验

完成标准：

- 同一用户在不同 RootEntity 下可以有不同角色
- 同一用户在同一 RootEntity 下可以有多个角色
- Agent 权限永远不超过 owner user 的 scoped permission
- TaskScope 可以按 entity、tag、relation type、relation depth 收窄
- 权限拒绝能返回可行动的 missing permissions

### Milestone 2: Memory Core State Model

目标：实现当前记忆状态模型和存储接口，不把 History / Sync 职责混入 Memory。

交付物：

- MemoryEntity
- MemoryEntityBranch
- MemoryRelation
- Resource
- ResourceChunk
- Resource CAS / Git-like 接口
- Qdrant-backed ResourceChunk / MemoryEntityBranch / MemoryEntity 接口
- libSQL-backed MemoryRelation 接口
- rootEntityId invariant
- L2 / L3 到 L1 的 source tracing

完成标准：

- RootEntity 使用 `rootEntityId = null`
- 非 RootEntity 和其他记忆对象都正确保存 rootEntityId
- Memory 模块接口只暴露当前状态读写和检索能力
- MemoryEntityBranch 支持多个候选分支同时被索引，并通过 status / confidence / branchRef / ranking policy 排序或过滤
- ResourceChunk、MemoryEntityBranch 和 MemoryEntity 元数据存 Qdrant payload
- MemoryRelation 存 libSQL relation table
- Memory 模块不拥有 commit、operation、rollback、replay 或 sync cursor

### Milestone 3: Authorized Retrieval

目标：让 Agent 能读取有用上下文，同时不能绕过 RBAC。

交付物：

- RetrievalPlanner
- L1 文本 / BM25 adapter boundary
- L1 vector adapter boundary
- L2 / L3 entity search
- relation expansion
- rank fusion interface
- evidence return format

完成标准：

- 每条检索路径都应用 rootEntityId 和 TaskScope
- 只读 ResearchAgent 只能读，不能写
- 返回的实体摘要能回溯到原始 Resource / Chunk

### Milestone 4: History Authority

目标：实现 Cloud History shared authority 和 Local History working authority，支持审计、撤回、回放、冲突和合并。

交付物：

- Cloud History Authority 持久化实现
- Local History working authority
- expectedHeadCommitId / clientMutationId 并发提交协议
- conflict key、MemoryConflict 和 conflict branch
- commitWatermark
- 本地 pending operation queue
- operation tree subset
- 管理员 resolution commit
- replay / rollback / revert / merge

完成标准：

- Cloud History 是共享记忆的唯一历史权威源
- Local History 是本地写入和查询的 working authority，但只对本地授权子集负责
- 本地只保存当前 subject 有读权限的 rootMemoryEntity 子集的 operation tree、pending operations、同步游标和少量 conflict metadata
- 云端并发冲突不会自动裁决，冲突来稿保存在 conflict branch
- 明确的 resolution commit 到达后，云端裁决覆盖本地 pending
- History 可重放到 Memory 当前状态

### Milestone 5: Local Authorized Working Replica And Sync

目标：实现 Cloud 全量权威和 Local 授权工作副本之间的同步。Local 不是完整 mirror，也不是薄 snapshot，而是按权限裁剪的本地工作副本。

交付物：

- Local Authorized Working Replica
- push / pull / conflict event / resolution event
- Authorized rootMemoryEntity subset downloader
- Resource CAS 子集同步
- Qdrant vector + payload 子集同步
- libSQL MemoryRelation 子集同步
- libSQL History operation tree 子集同步
- permissionWatermark
- 权限变化后的本地副本失效、清理与重建

完成标准：

- 用户有哪些 rootMemoryEntity 的读权限，本地就只下载并维护这些 rootMemoryEntity 的资源、Qdrant 数据、Qdrant payload、MemoryRelation 和 History operation tree
- 本地所有读取只走 Local Memory
- pending 写入无需等待云端即可进入 Local History，并投影到 Local Memory 后可检索
- 同步中断后可以从最后确认的 watermark 幂等继续
- 权限收窄后，本地资源、Qdrant payload、relation 和 history 子集中不再保留越权数据
- 本地副本可删除，并从 Cloud 重新构建到同一授权状态

### Milestone 6: Agent Session And Tool Integration

目标：通过受信任 session 为 Agent 注入用户身份，再接入工具可见性和各 Agent runtime。

交付物：

- PrincipalContext / Agent session
- Memory SDK
- ToolPermissionAdapter
- MainAgent / SubAgent delegation helpers
- TaskPermissionAnalyzer
- OpenClaw TypeScript 原生 memory plugin
- Hermes Python 原生适配器
- Claude Code MCP / HTTP adapter
- Codex MCP / HTTP adapter
- 只读调研 Agent 与专用写入 Agent 的集成测试

完成标准：

- Agent 不依赖 prompt 或工具参数携带 userId
- 服务端从 session、AgentIdentity 和 delegation 构造并验证 PrincipalContext
- Agent 可见工具与 effective permissions 一致
- 只读 subagent 看不到也调不到写工具
- 用户可以查询任务需要哪些权限、当前缺哪些权限、哪些角色能满足

### Milestone 7: 非核心产品能力

目标：在 RBAC、Memory、History 和 Sync 核心可靠后，再补产品体验和高级能力。

候选项：

- 管理 UI
- 审批队列 UI
- 图可视化
- 高级图数据库投影
- 同类记忆聚类摘要
- 遗忘曲线和访问频次评分
- 跨项目共享记忆建议
- analytics / observability dashboard
- 更丰富的导入流水线

这些能力不阻塞 Milestone 1-6。

## Issue 顺序

0. `DESIGN-NOTES.md`
1. `issues/01-architecture-contracts.md`
2. `issues/02-rbac-core-models.md`
3. `issues/03-policy-engine-and-router.md`
4. `issues/04-memory-core-models.md`
5. `issues/05-memory-versioned-write-path.md`
6. `issues/06-authorized-retrieval.md`
7. `issues/07-cloud-authority-concurrency.md`
8. `issues/08-local-authorized-snapshot-sync.md`
9. `issues/09-local-pending-conflict-resolution.md`
10. `issues/10-agent-session-identity.md`
11. `issues/11-agent-tool-permission-adapters.md`
12. `issues/12-non-core-feature-backlog.md`
13. `issues/13-split-memory-history-contracts.md`
14. `issues/14-memory-store-target-adapters.md`
15. `issues/15-history-libsql-authority.md`
16. `issues/16-local-authorized-working-replica.md`
17. `issues/17-sync-authorized-subset-events.md`
18. `issues/18-retire-postgres-prototype-adapter.md`

## 关键风险

- 如果第一版做任意实体级长期 ACL，权限、召回、缓存失效和审计复杂度会过早爆炸。
- 如果 Memory 引入 RBAC assignment 内部结构，两个模块会在早期耦合。
- 如果检索路径漏掉 rootEntityId 或 TaskScope，读权限隔离会失效。
- 如果本地记忆被当成共享权威源，权限变化后可能泄露旧记忆。正确说法是 Local History 是 local working authority，Cloud History 是 shared authority。
- 如果把 Local Authorized Working Replica 误实现成完整 mirror，会下载越权 rootMemoryEntity。它必须只是授权子集。
- 如果把 Local Authorized Working Replica 误实现成薄 snapshot，本地写入、回放、冲突和离线查询会缺少必要 operation tree。
- 如果未区分 Local Memory 当前状态和 Local History pending operations，“未裁决时本地优先”会被误实现成两个共享权威源。
- 如果 resolution commit 不引用被裁决的 conflict 和 incoming commit，本地无法安全判断何时应让云端覆盖 pending。
- 如果 Agent 身份来自 prompt 或工具参数，模型可以伪造 userId 或 ownerUserId。
- 如果 Agent 能自动执行管理员动作，委派自动化会变得不安全。

## 第一阶段建议

先完成 Milestone 0，然后连续推进 Milestone 1 和 Milestone 2。不要先做 UI、高级摘要、图投影或外部 Agent 适配。这个项目的地基是：

```txt
Scoped RBAC + Current Memory + Auditable History + Authorized Sync
```
