# 本地授权快照与增量同步

Status: ready-for-human

## What to build

实现 Cloud Memory Authority 到本地 authorized snapshot 的 bootstrap、增量 pull、权限失效和重建路径。本地只保存当前 subject 在 root、branch、TaskScope 下可见的 active snapshot、必要索引、pending operations、同步游标和少量冲突记录；不复制完整云端 commit/operation 历史。

本 issue 先完成“没有本地 pending 写入时”的同步闭环。pending overlay 和冲突优先级由 Issue 09 完成。

## Acceptance criteria

- [ ] 本地 view identity 至少包含 subjectId、rootEntityId、branchRef、taskScopeHash、commitWatermark 和 permissionWatermark。
- [ ] 首次 bootstrap 只下载当前身份和 TaskScope 被授权读取的 active snapshot。
- [ ] 增量 pull 只返回 commitWatermark 之后、且当前身份仍有权读取的变化。
- [ ] commitWatermark 使用云端单调顺序或等价游标，不依赖客户端时间戳排序。
- [ ] permissionWatermark 变化会在下一次本地读取前使旧 view 失效。
- [ ] 权限收窄后，本地实体、chunk、原始内容、embedding、全文索引和关系投影中的越权数据都会被清除，或整个 view 被原子替换。
- [ ] 本地存储中不存在完整云端 commit/operation 历史表；只允许 active snapshot、必要索引、pending operations、同步游标和少量 conflict metadata。
- [ ] 本地 view 可以完全删除，并从云端权威源重建到相同 authorized active state。
- [ ] 本地 SQL、FTS/BM25、vector、graph 和文件存储隐藏在可替换接口之后。
- [ ] 同步中断后可以从最后确认的 watermark 幂等继续。
- [ ] 本地查询通过 Issue 06 的授权查询源接口读取快照。
- [ ] bootstrap、增量 pull、断点续传、权限撤销和全量重建具有集成测试。

## Blocked by

- Issue 06 - 授权检索契约与可替换查询源
- Issue 07 - 云端权威提交与并发冲突捕获

## Comments

### 2026-06-25 Implementation

- 实现 `CloudAuthorizedViewAdapter`、`LocalAuthorizedViewStore`、`AuthorizedViewSynchronizer` 和本地查询源。
- local view identity 包含 subjectId、rootEntityId、branchRef、taskScopeHash、commitWatermark 和 permissionWatermark。
- bootstrap 只保存当前身份和 TaskScope 可见的 active snapshot。
- 增量同步只消费本地 watermark 之后的 accepted commits；conflict branch 不进入目标 view。
- 普通 create/update/tombstone 使用对象级 delta；revert 等复杂变化触发安全的原子 snapshot replacement。
- permissionWatermark 或 TaskScope 改变会使旧 view 失效或替换，并清除实体、chunk、关系和索引可见面中的越权数据。
- 本地存储 port 明确不保存完整云端 commit/operation 历史，只保留 snapshot、索引能力、pending/conflict 槽位和同步游标。
- 本地 view 删除后可以从云端重建；同步重试从最后确认 watermark 幂等继续。
- 增加 bootstrap、delta/noop、权限失效、TaskScope 收窄和全量重建测试。
