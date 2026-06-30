# Qdrant 与 libSQL Relation Store 授权检索闭环

Status: complete

## What to build

将 Memory 当前状态接入真实 Qdrant collections 和 libSQL relation table。调用方通过现有授权检索接口完成 entity/chunk 向量查询、relation expansion 与 L1 evidence 回溯，而不接触存储内部结构。

## Acceptance criteria

- [x] ResourceChunk、MemoryEntityBranch、MemoryEntity metadata 写入 Qdrant payload，relation 写入 libSQL。
- [x] 所有查询在存储调用前应用 rootEntityId、TaskScope 与状态过滤。
- [x] relation expansion 使用 libSQL edge table，遵守 relation type 与 maxDepth。
- [x] 检索结果可以回溯至有权限的 L1 evidence。
- [x] Qdrant/libSQL 重启后状态可恢复，in-memory query source 只用于测试。

## Implementation notes

- Added `QdrantVectorMemoryStore` for durable Qdrant-backed entity branch and chunk vector payloads.
- Added `LibsqlMemoryRelationStore` for durable relation edges and relation expansion.
- Added `StoreBackedAuthorizedQuerySource` so retrieval can use production stores while keeping `MemoryRetrievalAdapter` as the authorization boundary.
- Covered the restart path with `test/retrieval-store-adapters.test.ts`.

## Blocked by

- Issue 19 - 本地可运行开发栈与服务健康检查
- Issue 20 - 持久化 RBAC、身份认证与管理员 CLI
- Issue 21 - libSQL History Authority 生产适配器
- Issue 22 - CAS 资源导入、修订与内容读取闭环
