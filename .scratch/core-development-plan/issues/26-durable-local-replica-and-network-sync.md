# 持久化 Local Working Replica 与网络 Sync

Status: ready-for-agent

## What to build

把 Local Authorized Working Replica 从内存模型变成可离线工作的本地数据目录，并通过 HTTP/MCP 支持的同步协议 push/pull 授权 History 事件和 Memory 状态变更。同步只编排 Memory/History 接口，不直接耦合存储实现。

## Acceptance criteria

- [ ] 本地持久化授权 CAS、Qdrant payload/vector、relation、History subset、pending、conflict 与 cursor。
- [ ] 同步中断可从最后确认的 commitWatermark 幂等继续。
- [ ] pending push 被接受后标记 resolved；冲突在 resolution event 前仍保持本地可见。
- [ ] permissionWatermark 变化原子清理越权本地对象并重建授权子集。
- [ ] 删除本地副本后可重建到相同授权状态；离线检索不调用 Cloud。

## Blocked by

- Issue 21 - libSQL History Authority 生产适配器
- Issue 22 - CAS 资源导入、修订与内容读取闭环
- Issue 23 - Qdrant 与 libSQL Relation Store 授权检索闭环
- Issue 25 - HTTP 与 MCP 服务端授权记忆闭环
