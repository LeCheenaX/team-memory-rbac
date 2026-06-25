# 云端权威记忆与本地授权视图

Status: ready-for-agent

## 目标

实现云端权威记忆和本地授权 materialized view。

## 范围

- Cloud Memory Authority abstraction
- AuthorizedViewBuilder
- local view metadata
- commitWatermark
- permissionWatermark
- local query adapter
- invalidation strategy

## 验收标准

- 本地记忆永远不被当成权威源。
- 本地 view 记录 rootEntityId、branchRef、commitWatermark、permissionWatermark，以及必要的 taskScope。
- 权限变化会使旧本地 view 失效。
- 本地 view 能从云端权威源重建。
- 本地 SQL、vector DB、BM25、graph、Redis 都隐藏在可替换接口后。
- SQL 是 L2 / L3 权威结构的优先实现；Graph DB 只能作为可重建投影。
- Redis 只能用于权限、热点实体、relation expansion、本地同步状态或 Agent 会话短缓存，不能作为权威记忆源。

## 优先级

重要，但排在 RBAC 和记忆写语义稳定之后。
