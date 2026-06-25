# 授权检索契约与可替换查询源

Status: ready-for-human

## What to build

实现始终遵守 RBAC 和 TaskScope 的统一检索路径，并把“从哪里查询”隐藏在可替换的授权查询源之后。该查询源既可以指向云端 active view，也可以指向后续的本地 authorized snapshot + pending overlay；调用方不得依赖具体 SQL、BM25、向量或图存储。

本 issue 只建立授权检索语义和查询源边界，不实现本地同步、pending overlay 或冲突裁决。

## Acceptance criteria

- [ ] 每个检索请求都经过 PermissionRouter，并强制包含 rootEntityId。
- [ ] 返回结果前应用 TaskScope 的 entity、resource、tag、relation type 和 maxDepth 限制。
- [ ] 未授权检索返回 PermissionDecision 和 missing actions，不返回部分结果。
- [ ] 查询源接口支持 L1 文本/BM25、L1 vector、L2/L3 entity search、relation expansion 和 evidence lookup。
- [ ] 查询调用方不知道结果来自云端 active view、本地 authorized snapshot 或其他可替换投影。
- [ ] 返回 L2/L3 结果时可以携带可验证的 L1 ResourceChunk evidence references。
- [ ] 关键词检索、语义检索、关系展开和 evidence 回溯各有契约测试。
- [ ] 只读 Agent 可以检索，但同一身份不能经由检索接口执行写入。
- [ ] 工作流检索可以先找到 workflow entity，再通过 has、depends_on、next_is 展开。
- [ ] 查询结果包含足够的来源标记，使后续本地查询能区分 cloud snapshot 与 local pending overlay。

## Blocked by

- Issue 03 - Policy Engine 与 Permission Router
- Issue 04 - 记忆核心模型
- Issue 05 - 记忆版本化写路径

## Comments

### 2026-06-25 Implementation

- 实现统一 `MemoryQuerySource` 和 `MemoryRetrievalAdapter`，查询调用方不依赖云端、本地或具体索引实现。
- 支持 keyword、semantic、entity、relation expansion、workflow 和 evidence lookup。
- 所有请求继续通过 PermissionRouter；拒绝请求不会进入查询源。
- 检索结果在返回前应用 rootEntityId、TaskScope entity/resource/tag、relation type 和 maxDepth 过滤。
- L2/L3 entity 结果可以通过 `refers_to` 回溯 L1 ResourceChunk evidence。
- 结果包含 `cloud_active`、`local_snapshot` 或 `local_pending` 来源标记。
- 增加授权检索契约测试，覆盖关键词、向量、实体、关系、工作流、证据和拒绝路径。
