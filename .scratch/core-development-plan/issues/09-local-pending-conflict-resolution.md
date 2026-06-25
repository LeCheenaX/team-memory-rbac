# 本地 Pending Overlay 与人工冲突裁决闭环

Status: ready-for-agent

## What to build

实现离线/低延迟本地写入、即时检索、push 冲突、管理员人工裁决和 resolution pull 的完整闭环。

本地写入先进入 pending operation queue，并同步更新 local pending overlay 及其必要索引，因此无需等待云端即可被检索。云端仍是系统权威源；“未裁决时本地为权威”专指本机查询组合规则：pending overlay 暂时遮蔽 cloud snapshot，不代表本地可以改写云端 active branch。

云端收到相同 conflict key 的并发 commit 时，沿用 Issue 07 的 unresolved conflict branch，不自动裁决。管理员通过 take incoming、keep target 或 manual merge 创建 resolution commit。resolution 必须明确引用已解决的 conflict 和被裁决的 incoming commit，使本地能够识别“这不是普通远程更新，而是云端已经裁决过的结果”。

## Acceptance criteria

- [ ] 本地写入在一个本地事务中追加 pending operation、更新 pending overlay 并更新必要检索索引。
- [ ] 写入成功返回后、尚未 push 前，关键词、语义、entity 和 relation 查询都能立即召回 pending 结果。
- [ ] 查询按 cloud snapshot + pending overlay 组合；相同 conflict key 下 pending create/update 遮蔽 snapshot，pending tombstone 隐藏 snapshot。
- [ ] pending operation 包含 baseCommitId、clientMutationId、conflict keys、actor/session provenance 和本地顺序。
- [ ] pull 到普通远程变更且尚无云端裁决标记时，与其冲突的 pending overlay 保持本地可见，并标记为 unresolved。
- [ ] pull 到明确引用当前 pending/incoming commit 的 resolution commit 时，云端裁决结果覆盖本地 overlay。
- [ ] 被 resolution 覆盖的 pending operation 不会静默删除，而是进入 resolved/rejected/superseded 状态并保留最小审计信息。
- [ ] 无关 conflict key 的远程变化可以进入 snapshot，不阻塞现有 pending overlay。
- [ ] push 遇到云端 conflict 时，本地 pending operation 保留，并关联云端 MemoryConflict 和 conflict branch。
- [ ] 管理员可以选择 keep target、take incoming 或 manual merge；每种选择都会产生新的 resolution commit，而不是改写历史。
- [ ] resolution commit 包含 resolvedConflictIds、resolvedIncomingCommitIds 和 resolution kind。
- [ ] 云端 conflict 在管理员裁决前不改变目标 branch active head。
- [ ] 本地重启后 pending overlay、冲突关联和即时召回行为保持一致。
- [ ] 测试覆盖：离线写后立即查询、普通 pull 与 pending 冲突、未裁决时本地遮蔽、裁决后云端覆盖、非冲突增量合并、删除与修改冲突、重复 push/pull。

## Blocked by

- Issue 07 - 云端权威提交与并发冲突捕获
- Issue 08 - 本地授权快照与增量同步
