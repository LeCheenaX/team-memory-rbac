# 授权检索

Status: ready-for-agent

## 目标

实现始终遵守 RBAC 和 TaskScope 的记忆检索。

## 范围

- RetrievalPlanner
- L1 text / BM25 adapter boundary
- L1 vector adapter boundary
- L2 / L3 entity search
- relation expansion
- rank fusion interface
- evidence / source return format

## 验收标准

- 每个检索请求都包含 rootEntityId filter。
- 返回结果前必须应用 TaskScope filters。
- relation expansion 遵守 allowed relation types 和 maxDepth。
- 返回 L2 / L3 记忆时可以带 L1 evidence references。
- 未授权检索返回 PermissionDecision 和 missing actions，不返回部分未授权记忆。
- 测试证明只读 Agent 可以检索但不能写入。
- 关键词明确时可优先 BM25；语义问题可优先 vector；需要证据时必须返回 L1 chunk 引用。
- 工作流检索支持先找 workflow entity，再通过 has / depends_on / next_is 展开。
- 冲突检索使用 contradicts relation。

## 优先级

核心相邻。放在版本化写路径之后。
