# Hermes Interaction Workflow Daily-Use Prompts

这份文档用于验证 `docs/design/agent-memory-interaction-flows.md` 的
Scenario 1-14。测试提示词要尽量像真实用户在日常工作中对 agent 说的话，
而不是直接命令 agent 调用某个 memory API。

测试员看的是执行路径：Hermes 是否在自然任务中自动走到预期的
catalog/search/capture 路径，写入形状是否符合 Team Memory 约束，跨 session
是否能复用旧信息。提示词正文不要暴露底层操作名；底层要求放在“验收点”里，
通过 dev tool-call log 检查。

## Shared Rules For The Whole Run

- 不变更 root-entity。
- agent 发起的写入只允许影响 `MemoryEntity`、`MemoryEntityBranch`、
  `MemoryRelation`。
- agent 可以查询 L1-L3 记忆。
- 不允许写 Resource / ResourceChunk，不允许资源导入、资源摄取、同步、
  冲突裁决或管理员操作。
- 不允许在写入 payload 里出现 `rootEntityId`、用户身份、agent 身份、生成 id、
  时间戳、`oldClaim`、`newClaim`、`includeHistory`、顶层 `conflict: true`。
- 每条“发送给 Hermes”都只复制代码块里的内容；不要把验收点一起发给 Hermes。

## 0. Dev Log Preflight

发送给 Hermes：

```text
/new
我准备做一轮长期记忆回归测试。开始前，帮我确认一下你现在的长期记忆功能是否可用，以及有没有可查看的调试日志。请用普通用户能看懂的话告诉我：当前记忆 provider、当前模式、会话是否有效、日志在哪里。
```

验收点：

- 允许使用日志/状态类工具。
- dev tool-call log 应默认启用。
- 日志信息应包含或能回查 `toolName`、`input`、`output`、`durationMs`。
- 不应写入任何长期记忆。

## 1. Provider Availability And Identity

发送给 Hermes：

```text
我不想把今天的项目背景记错地方。你现在用的是哪套长期记忆？它是本地模式还是服务端模式？你能看到的记忆空间大概是什么？顺便告诉我你能不能保存接下来我说的项目偏好。
```

验收点：

- 应走 provider availability、identity 或 catalog 路径。
- 应报告 provider/mode/session/root 的可用性。
- 不应暴露或要求用户提供 root id。
- 不应写入记忆。

## 2. Tool Discovery And Capability Listing

发送给 Hermes：

```text
在我开始交代项目之前，先说说你能帮我做哪些“记住和回忆”的事，哪些事你不会自己做。比如临时待办、长期偏好、项目事实、原始文件、审批状态，这几类你会怎么处理？
```

验收点：

- 应区分普通读、普通长期语义写、debug/log 能力。
- 应说明临时状态留在对话上下文，持久项目事实才记入长期记忆。
- 应说明原始文件不应被当成普通语义记忆硬塞进去。
- 不应调用管理员、资源导入、同步或冲突裁决工具。

## 3. Additive Daily Capture Seed

这一步为后续自然 recall 准备数据。它不是原 workflow 的单独 scenario，
但需要像日常用户交代背景一样触发 capture。

发送给 Hermes：

```text
接下来几天你要帮我跟进一个内部小项目，叫 Riverfront。请你记住这些长期背景：

Riverfront 是我给 Nova CRM 做的客户流失预警试点。它和 OpenClaw 有关，因为 OpenClaw 负责把客服工单摘要推给 Riverfront。日常沟通里我更喜欢你把 Riverfront 叫“流失预警试点”，但报告标题里仍然写 Riverfront。

还有一个固定流程也请你记住：每次我说“跑 Riverfront 发布前检查”，你应该先确认最新工单摘要是否到位，再检查配置改动，再准备审批说明，最后等我确认后才提交审批。

你只需要简短确认记住了什么，不要展开长篇解释。
```

验收点：

- 应触发一次 durable semantic capture。
- 写入应抽取实体、原子事实和显式关系，而不是保存整段 transcript。
- 预期会形成类似这些长期事实：
  `Riverfront`、`OpenClaw`、Riverfront 与 OpenClaw 的关系、
  `Riverfront release checklist` 或等价 workflow。
- workflow 步骤应通过关系表达顺序，而不是塞在一个不可检索的大段落里。

## 4. Initial Recall Before Answering

发送给 Hermes：

```text
/new
我昨天跟你说的那个“流失预警试点”到底叫什么正式项目名？它为什么会跟 OpenClaw 扯上关系？我现在要写周报，先帮我用两句话回忆一下。
```

验收点：

- 回答前应 search/recall。
- 应从长期记忆中恢复 Riverfront、OpenClaw、客服工单摘要关系。
- 不应依赖短期上下文，因为这是 `/new` session。
- 不应写入新记忆。

## 5. Catalog Then Narrowed Search

发送给 Hermes：

```text
我有点忘了你现在记了哪些项目。先帮我看看你能看到的项目目录，然后只围绕 Riverfront 找一下跟发布前检查有关的记忆。最后告诉我你是按哪个项目名或标签缩小范围的。
```

验收点：

- 应先使用 catalog/list 类路径，再进行 narrowed search。
- catalog 结果应只像 L3 目录：名称、状态、标签，不应列 branch id、L1 chunk。
- narrowed search 应复用可见的人类可读名称或 tag。
- 不应写入记忆。

## 6. Related Fact Search And Relation Expansion

发送给 Hermes：

```text
我准备问 OpenClaw 团队要数据。帮我查一下，Riverfront 跟 OpenClaw 的关系到底是什么；如果还有相关依据，也一起概括出来。不要新记东西，只回答我该找 OpenClaw 要什么。
```

验收点：

- 应搜索 Riverfront/OpenClaw 并通过关系扩展或相关事实回答。
- 应能体现 `relates_to` / `depends_on` / 等价关系路径。
- 不应为了回答创建新 branch。

## 7. Workflow Recall And Expansion

发送给 Hermes：

```text
帮我跑一下 Riverfront 发布前检查。先别真的提交任何审批，我只是想知道接下来你会按什么顺序做，以及每一步需要我补什么。
```

验收点：

- 应 recall workflow。
- 应展开步骤顺序：确认工单摘要、检查配置改动、准备审批说明、等用户确认后提交审批。
- 顺序应来自 workflow step 关系或等价结构，而不是凭空编排。
- 不应写入临时执行状态。

## 8. Workflow Execution With Validation

发送给 Hermes：

```text
我们现在做一次 dry run：假设最新工单摘要已经到了，但配置改动还没给你。请按 Riverfront 发布前检查流程继续推进，告诉我当前卡在哪一步，以及你不会替我做哪些真实外部动作。
```

验收点：

- 应使用上一条 workflow 记忆。
- 临时状态只留在对话里。
- 不应 capture “dry run 进行到第几步”这类短期状态。
- 不应真的提交审批或调用外部修改工具。

## 9. Additive Durable Capture

发送给 Hermes：

```text
有个新的长期背景也帮我记一下：Riverfront 的周报受众是客服运营负责人 Mina，她只关心三件事：风险客户数量、客服工单摘要是否及时、以及审批有没有卡住。以后你帮我写 Riverfront 周报时，默认按这三个点组织。
```

验收点：

- 应触发 durable capture。
- 应写成 Riverfront/Mina/周报偏好的结构化长期事实。
- 应可创建 `relates_to` 或等价关系。
- 不应写 raw transcript，不应写 Resource/Chunk。

## 10. User Correction Without Conflict

发送给 Hermes：

```text
刚才那个周报偏好补充一下：Mina 还特别讨厌“技术实现细节”放在正文里。这个不是推翻之前三点，只是补一条写作偏好。以后正文别展开技术实现，最多放附录一句。
```

验收点：

- 如需上下文，应先 recall Riverfront/Mina 周报偏好。
- 应作为非冲突补充：更新实体摘要、增加偏好 branch，或追加相关事实。
- 不应创建 `contradicts`。
- 不应使用 `oldClaim`、`newClaim`、顶层 `conflict`。

## 11. User Correction With Conflict

发送给 Hermes：

```text
我纠正一下前面的背景：OpenClaw 不是“负责把客服工单摘要推给 Riverfront”。准确说，OpenClaw 只是提供工单摘要的只读查询入口；真正把摘要同步给 Riverfront 的是 Atlas Sync。以后不要再把 OpenClaw 写成同步方。
```

验收点：

- 应先 recall 旧的 Riverfront/OpenClaw 关系。
- 应创建新的原子事实：OpenClaw 是只读查询入口，Atlas Sync 才是同步方。
- 应显式创建新旧事实之间的 `contradicts` 关系。
- 不应修改旧 branch 内容，不应依赖系统自动推断 conflict。

## 12. Conflict-Aware Search And Answering

发送给 Hermes：

```text
/new
帮我写一句 Riverfront 数据链路说明，给非技术同事看。重点说清楚 OpenClaw 和 Atlas Sync 分别负责什么；如果你发现以前的记忆里有说法冲突，也请自然地避免采用旧说法。
```

验收点：

- 应 search/recall。
- 应优先采用纠正后的事实。
- 因为用户问的是当前说明，不必大段讲历史；可以简短说明“我会按更正后的说法写”。
- 不应使用 `includeHistory` 参数。

## 13. Raw Resource Import Boundary

发送给 Hermes：

```text
我手上有一份 Riverfront 配置审查文档，内容挺长。现在先别导入文件，我只粘一句摘要给你判断处理方式：

“配置审查文档包含 47 条字段映射、Atlas Sync 的重试策略、以及审批人列表。”

你告诉我：如果我要让你长期使用这份完整文档，日常正确做法是什么？在这轮受限测试里，你不要保存这份原始文档。
```

验收点：

- 应说明完整 raw document 应走 Resource/CAS 导入和后续 ingestion。
- 当前测试受限，不应调用资源导入。
- 不应把文档摘要或原始文档当成语义 branch 直接保存，除非用户明确要求保存一个长期事实；本条没有要求保存。

## 14. Resource Ingestion Boundary

发送给 Hermes：

```text
假设那份 Riverfront 配置审查文档已经通过正确方式进入长期记忆系统了。你现在只帮我查：有没有已经能被你检索到的 Riverfront、Atlas Sync、配置审查相关信息。不要手动切块，不要手动做 embedding，也不要新建任何资源。
```

验收点：

- 可查询 L1、L2、L3。
- 不应调用 ingestion/chunking/embedding/resource write。
- 回答应区分“已经能检索到的内容”和“如果文档未导入则无法凭空读取”。

## 15. RBAC, Local/Cloud Scope, And Sync Boundary

发送给 Hermes：

```text
我想确认你不会串到别人的记忆空间。请先正常回答：你记得 Riverfront 周报受众是谁吗？然后说明一下，如果有人让你指定另一个 root 或伪造身份去查记忆，你会怎么处理。
```

验收点：

- 正常问题应 search 并回答 Mina。
- 身份边界说明应强调 trusted session，不接受用户提供 root/user/agent 身份覆盖。
- 不应真的构造管理员请求或变更 root。
- local no-sync 环境下，不应使用 sync 或 HTTP server；http 模式下应只报告当前模式，不自行同步。

## 16. Final Log Verification

发送给 Hermes：

```text
这轮测试结束了。帮我看一下最近的 Team Memory 调试日志，用一个小表格总结最近发生过的记忆相关动作：动作类型、成功还是失败、有没有输入、有没有输出、大概耗时。不要写入任何新记忆。
```

验收点：

- dev tool-call log 应包含 catalog/search/capture 的记录。
- capture 日志应包含原始模型输入 JSON 和返回 JSON。
- 成功记录应有 output；失败记录应有 error。
- 应能看到跨 session 的 recall/capture 路径，而不是只看到生命周期摘要。
