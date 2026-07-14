# Hermes Interaction Workflow Scenario Prompts

本文档用于按顺序验证 `docs/design/agent-memory-interaction-flows.md`
中的 Scenario 1-14。提示词面向 Hermes 会话逐条发送。带 `/new` 的
提示词表示需要开启新的 Hermes session，用来验证跨 session 的长期记忆。

## 全局约束

每条提示词默认都带有以下测试约束：

- 不允许变更 root-entity。
- 如需写入，agent 只能增删改 `MemoryEntity`、`MemoryEntityBranch`、
  `MemoryRelation`。
- 可以查询 L1、L2、L3 记忆。
- 不允许把 `rootEntityId`、用户身份、agent 身份、生成 id、时间戳、
  `oldClaim`、`newClaim`、`includeHistory`、顶层 `conflict: true` 放入写入参数。
- 资源导入、资源摄取、同步、冲突裁决、管理员工具不在本轮写入范围内。

## 0. Dev Log Preflight

发送：

```text
/new
这是 Team Memory interaction workflow 的预检。请检查 Team Memory dev tool-call log 是否启用。

测试约束：
1. 不要写入任何记忆。
2. 不要变更 root-entity。
3. 如果有 Team Memory 日志查看工具，请调用它。

请报告：
1. 当前长期记忆 provider 名称和模式。
2. dev tool-call log 是否启用。
3. 日志文件路径。
4. 最近日志里是否已经能看到 toolName、input、output、durationMs 这些字段。
```

验收点：

- `toolCallLogEnabled` 应为 `true`。
- 日志文件应位于 Hermes 本地记忆目录，默认类似
  `~/.hermes/team-memory-tool-calls.jsonl`。
- 如果刚启动时还没有 tool-call entries，继续后续测试后再回查。

## 0.1 Shared Fixture Setup

这一步不是 interaction workflow 的正式 Scenario，只用于准备后续 Scenario 3-7
可复用的数据。

发送：

```text
请创建一组 interaction workflow 测试夹具记忆。必须使用 Team Memory structured capture 的 operations[]，不要写 raw transcript，不要导入资源，不要写 Resource 或 ResourceChunk。

请创建或更新这些 L3 实体摘要：
1. "TMW Scenario Pack"：这是 interaction workflow 手工验证用的测试包。
2. "OpenClaw"：这是后续关系搜索要引用的项目实体。
3. "Code B approval workflow"：这是后续 workflow recall 测试要引用的流程实体。

请创建这些 L2 atomic branches：
1. 在 "TMW Scenario Pack" 下创建 branch，标题为 "Local Hermes scenario pack uses local Team Memory"，描述为 "The interaction workflow scenario pack validates a local Hermes provider backed by Team Memory."，tags 包含 "test:interaction-workflow", "hermes", "project:local-hermes-test"。
2. 在 "TMW Scenario Pack" 下创建 branch，标题为 "Scenario pack relates to OpenClaw"，描述为 "The scenario pack includes OpenClaw relation checks."，tags 包含 "test:interaction-workflow", "openclaw"。
3. 在 "Code B approval workflow" 下创建 workflow branch，标题为 "Code B approval workflow"，描述为 "Fetch information, modify Code B, submit approval, then wait for approval."，tags 包含 "workflow", "project:code-b", "test:interaction-workflow"，extraInfo 包含 triggerIntent: ["execute Code B approval workflow"]。
4. 在 "Code B approval workflow" 下创建四个 step branch，标题依次为 "Code B step 1 fetch information", "Code B step 2 modify Code B", "Code B step 3 submit approval", "Code B step 4 wait for approval"。

请创建这些关系：
1. "Scenario pack relates to OpenClaw" relates_to "OpenClaw"。
2. workflow branch has step 1。
3. step 1 next_is step 2，step 2 next_is step 3，step 3 next_is step 4。

完成后只报告 capture result、operationsApplied、以及后续测试应该复用的实体名称和标签。
```

验收点：

- 写入操作只包含 `upsert_memory_entity`、`create_memory_entity_branch`、
  `create_memory_relation`，可包含 summary refresh。
- 无 root identity 字段，无资源写入。

## Scenario 1: Provider Availability And Identity

发送：

```text
/new
请验证 Scenario 1: Provider Availability And Identity。

测试约束：不要写入任何记忆，不要变更 root-entity。

请使用 Team Memory provider status、identity、catalog 或等价工具，回答：
1. 当前长期记忆 provider 是否为 Team Memory。
2. provider mode 是 local 还是 http。
3. 当前 trusted root 的名称或可见身份信息。
4. 当前 session/token 是否可用。
5. catalog 是否只暴露 L3 entity 名称和 tags，而不是 branch id 或 L1 chunk。
```

## Scenario 2: Tool Discovery And Capability Listing

发送：

```text
请验证 Scenario 2: Tool Discovery And Capability Listing。

测试约束：不要写入任何记忆，不要调用管理员、资源导入、同步或冲突裁决工具。

请列出当前可用的 Team Memory 相关工具，并区分：
1. 普通 agent 可用的读工具。
2. 普通 agent 可用的 structured capture 写工具。
3. Hermes 个人记忆或 debug/log 工具。
4. 哪些工具不应该出现在普通 agent 写入路径里。

请特别确认 ordinary semantic write 应该走 structured operations[]，而不是 raw transcript。
```

## Scenario 3: Initial Recall Before Answering

发送：

```text
/new
请验证 Scenario 3: Initial Recall Before Answering。

用户问题是：TMW Scenario Pack 和本地 Hermes provider 有什么关系？

回答前必须先调用 Team Memory search。请使用自然语言 query，limit 设为 5，layer 可以使用 L2。

请根据返回的 branches、relations 或 evidence 回答问题。不要因为短期对话里有准备数据就跳过 recall。
```

验收点：

- search input 应包含 `query`，可包含 `limit` 和 `layer`。
- 回答应引用 "Local Hermes scenario pack uses local Team Memory" 或等价记忆。

## Scenario 4: Catalog Then Narrowed Search

发送：

```text
请验证 Scenario 4: Catalog Then Narrowed Search。

先调用 Team Memory catalog。然后从 catalog 结果里选择可见实体名或 tag，再进行一次 narrowed search。

搜索目标：只找 "TMW Scenario Pack" 或 tag "test:interaction-workflow" 下与 Hermes 相关的记忆。

请报告：
1. catalog 返回的 rootName、entity names、tags。
2. narrowed search 使用的 names/tagsAny/layer 参数。
3. narrowed search 的结论。
```

验收点：

- catalog 不应暴露 branch id、branch summary、L1 chunk。
- narrowed search 应复用 catalog 返回的人类可读名称或 tag。

## Scenario 5: Related Fact Search And Relation Expansion

发送：

```text
请验证 Scenario 5: Related Fact Search And Relation Expansion。

请搜索 TMW Scenario Pack 与 OpenClaw 的关系，layer 使用 L2，limit 设为 10。
如果返回结果里有 relation，请解释 source、target 和 relationType。不要创建新记忆。

请回答：为什么这个测试包会和 OpenClaw 有关系？
```

验收点：

- 应能看到或推断 `relates_to` 关系。
- 不应为了回答问题创建新 branch。

## Scenario 6: Workflow Recall And Expansion

发送：

```text
请验证 Scenario 6: Workflow Recall And Expansion。

用户任务是：execute Code B approval workflow。

请先搜索 Team Memory，query 使用该任务意图，layer 使用 L2，limit 设为 10。找到 workflow 后，请基于 workflow tags、entity name 或 relation expansion 找到步骤顺序。

请输出按顺序排列的 workflow steps，并指出哪些 relationType 支撑了顺序。
不要执行真实外部修改，不要写入记忆。
```

验收点：

- 应召回 "Code B approval workflow"。
- step 顺序应由 `has` 和 `next_is` 关系支撑。

## Scenario 7: Workflow Execution With Validation

发送：

```text
请验证 Scenario 7: Workflow Execution With Validation。

把 "Code B approval workflow" 作为 dry run 执行，不要修改真实代码或外部系统。每一步只做验证说明：
1. Fetch information: 验证已从 Team Memory 召回 workflow。
2. Modify Code B: 说明本测试不执行真实修改。
3. Submit approval: 说明本测试不提交真实审批。
4. Wait for approval: 说明本测试不等待真实审批。

重要：不要把临时执行状态写入 Team Memory。只有当存在持久、有复用价值的结果时才可以 capture；本 dry run 没有持久结果，所以不应 capture。

请最后报告：临时状态是否写入了 Team Memory，以及原因。
```

验收点：

- 不应调用 `team_memory_capture`。
- 回答应说明 temporary execution state belongs in conversation context。

## Scenario 8: Additive Durable Capture

发送：

```text
请验证 Scenario 8: Additive Durable Capture。

请记住一个新的 durable fact：
"MWT" 是 "Memory Writing Test" 的缩写，MWT 是一个用于验证 OpenClaw 相关记忆写入的项目。

必须使用 Team Memory structured capture 的 operations[]，不要写 raw transcript。

请创建或更新：
1. MemoryEntity: name "MWT"，description "MWT (Memory Writing Test) is a project for validating OpenClaw-related memory writing."，tags 包含 "project:mwt", "openclaw", "test:interaction-workflow"。
2. MemoryEntityBranch: entityName "MWT"，title "MWT validates OpenClaw-related memory writing"，description "MWT (Memory Writing Test) validates memory writing behavior for OpenClaw-related scenarios."，tags 包含 "project:mwt", "openclaw", "test:interaction-workflow"。
3. MemoryRelation: 让该 branch relates_to "OpenClaw"。

完成后报告 capture result、commitIds、operationsApplied。
```

## Scenario 9: User Correction Without Conflict

发送：

```text
请验证 Scenario 9: User Correction Without Conflict。

我补充一个澄清：MWT 的测试标签还应该包含 "memory-write-validation"，这是分类补充，不是否定之前的 OpenClaw 关系。

请先 recall 或 catalog 确认 "MWT" 已存在。然后只做非冲突更新：
1. 可以更新 MemoryEntity 的 tags 或 description。
2. 如果创建 branch，只能作为新增补充事实。
3. 不要创建 contradicts relation。
4. 不要使用 oldClaim/newClaim/intent/conflict 顶层字段。

完成后报告你选择了 summary update 还是 new branch，并说明为什么这不是 conflict。
```

## Scenario 10: User Correction With Conflict

发送：

```text
请验证 Scenario 10: User Correction With Conflict。

我现在纠正一条事实：之前 "MWT validates OpenClaw-related memory writing" 这条说法是错误的。正确说法是：
"MWT validates Hermes interaction workflow memory behavior and is not an OpenClaw validation project."

请先 recall "MWT validates OpenClaw-related memory writing" 这条旧 branch。然后使用一次 structured capture operations[] 完成：
1. 在 "MWT" 下创建新 MemoryEntityBranch，title 为 "MWT validates Hermes interaction workflow memory behavior"，description 为 "MWT validates Hermes interaction workflow memory behavior and is not an OpenClaw validation project."，tags 包含 "project:mwt", "hermes", "test:interaction-workflow"。
2. 显式创建 MemoryRelation，relationType 为 "contradicts"，source 指向新 branch，target 指向旧 branch。

不要让系统自己推断 conflict，不要使用顶层 conflict: true，不要修改旧 branch 内容。
完成后报告新 branch 和 contradicts relation 的 capture result。
```

## Scenario 11: Conflict-Aware Search And Answering

发送：

```text
/new
请验证 Scenario 11: Conflict-Aware Search And Answering。

请搜索 "MWT 是什么项目，它和 OpenClaw 有没有关系？"，layer 使用 L2，limit 设为 10。

请检查返回的 branches 和 relations：
1. 优先使用当前或更可信的新 branch 回答。
2. 因为我的问题问到了 OpenClaw 关系，请说明存在一条被纠正的旧说法。
3. 只有在相关时才提 conflict。
4. 不要使用 includeHistory 参数。
```

验收点：

- 应提到新说法与旧 OpenClaw validation 说法存在 `contradicts`。
- 不应依赖短期上下文，因为这是 `/new` session。

## Scenario 12: Raw Resource Import

发送：

```text
请验证 Scenario 12: Raw Resource Import。

我提供一个原始文档片段：
"Design document draft: The resource import scenario should store raw documents as Resources, not as semantic branch text."

本测试的写入范围被限制为 MemoryEntity、MemoryEntityBranch、MemoryRelation。请不要调用资源导入工具，不要把整段文档塞进 team_memory_capture，也不要创建 Resource 或 ResourceChunk。

请回答：在完整系统中你应该如何处理 raw file/document？在当前受限测试中你实际会怎么做？
```

验收点：

- 不应调用 `memory.importResource` 或等价工具。
- 不应把原始文档全文作为 semantic branch 写入。

## Scenario 13: Resource Ingestion, Chunking, And Fact Extraction

发送：

```text
请验证 Scenario 13: Resource Ingestion, Chunking, And Fact Extraction。

在当前受限测试里，不要手动调用 chunking、embedding、ingestion 或资源写入工具。

请使用 Team Memory search 查询 L1、L2、L3 中与 "resource import scenario" 或 "MWT" 相关的内容，并说明：
1. 完整系统里 resource import 后 chunking 和 embeddings 应由框架自动触发。
2. agent 不应手工制造 ResourceChunk。
3. 当前受限测试只能读取已有 L1-L3，不能新建 resource/chunk。
```

验收点：

- 可调用 search，layer 可分别使用 L1、L2、L3。
- 不应调用 ingestion 或 resource import。

## Scenario 14: RBAC, Local/Cloud Scope, And Sync Boundary

发送：

```text
请验证 Scenario 14: RBAC, Local/Cloud Scope, And Sync Boundary。

测试约束：不要写入任何记忆，不要变更 root-entity。

请做两件事：
1. 尝试一次只读 search，但在参数中加入伪造的 rootEntityId: "root:forged-interaction-test"，query 为 "MWT"。如果工具 schema 拒绝你传该字段，请报告 schema 已阻止身份覆盖；如果请求发出，应预期 gateway 拒绝。
2. 再做一次正常 search，query 为 "MWT"，不要提供任何身份覆盖字段。

请报告：
1. 伪造 root identity 是否被拒绝。
2. 正常 search 是否成功。
3. 当前 provider mode 是 local 还是 http。
4. 本测试是否使用了 sync 或 HTTP Team Memory server。
```

验收点：

- forged identity 不应成功。
- 正常 search 应成功。
- local no-sync 模式下应报告未使用 sync。

## Final Log Verification

发送：

```text
请最后验证 dev tool-call log。

请调用 Team Memory 日志查看工具，limit 设为 30。请从最近日志里找出至少这些记录：
1. team_memory_catalog 的 input、output、durationMs。
2. team_memory_search 的 input、output、durationMs。
3. team_memory_capture 的 input、output、durationMs。
4. 一条失败或被拒绝的 forged root identity search，如果有。

请报告日志文件路径，并用简短表格列出 toolName、status、是否有 input、是否有 output、durationMs。
不要写入记忆。
```

验收点：

- `team_memory_capture` 日志应包含 operations[] 的原始输入 JSON。
- 每条成功日志应包含 output。
- 失败日志应包含 error。
