# 云端权威提交与并发冲突捕获

Status: ready-for-human

## What to build

把 Issue 05 的内存权威写模型落到可持久化的 Cloud Memory Authority。云端保存完整 append-only commit/operation 历史、branch head、快照和审计记录；客户端提交时携带其编辑基线，云端使用 optimistic concurrency 检测并发。

如果两个 commit 修改同一个 conflict key，云端不得自动选择赢家或执行 last-write-wins。云端保存来稿，在独立 conflict branch 和 MemoryConflict 记录中等待管理员处理，目标 branch 的 active head 保持不变。

第一版优先使用 PostgreSQL 保存 L2/L3、commit、operation、branch、snapshot、conflict 和审计元数据；原始大对象可由 Object Storage 保存。Graph、vector、BM25 和 Redis 只能是可重建投影或缓存。

## Acceptance criteria

- [ ] 提交命令包含 expectedHeadCommitId 和 clientMutationId。
- [ ] 同一 rootEntityId + branchRef 的 head 检查、commit、operations、branch 更新和 outbox event 在一个事务中完成。
- [ ] clientMutationId 重试具有幂等性，不产生重复 commit 或 operation。
- [ ] 每类可变对象都有稳定 conflict key；至少覆盖 Resource、MemoryEntity 状态、MemoryEntityBranch 和 MemoryRelation。
- [ ] expectedHeadCommitId 落后但新增操作未触碰相同 conflict key 时，云端可以安全 rebase 并提交。
- [ ] 两个并发 commit 触碰相同 conflict key 且结果不等价时，第二个来稿不进入目标 branch active view。
- [ ] 冲突来稿被完整保存在系统生成的 conflict branch，并生成 unresolved MemoryConflict。
- [ ] 云端发现冲突时不自动 merge、不做 last-write-wins，也不自动裁决删除与修改冲突。
- [ ] MemoryConflict 记录 base commit、target branch、remote head、incoming commit、conflict keys、参与 actor 和状态。
- [ ] revert 继续表现为新增 commit；历史 commit 和 operation 不被物理删除。
- [ ] 权威 active projection 被删除后，可以从云端 operation log 重建。
- [ ] Redis、vector、BM25 和 Graph 数据全部删除后，不影响权威数据，并可以重建。
- [ ] 并发、幂等、事务回滚、非冲突 rebase 和冲突分支创建具有集成测试。

## Blocked by

- Issue 05 - 记忆版本化写路径

## Comments

### 2026-06-25 Implementation

- 实现 `CloudMemoryAuthority` port 和 `InMemoryCloudMemoryAuthority` 领域参考实现。
- 提交支持 `expectedHeadCommitId`、`clientMutationId`、单调 sequence、事务 outbox 和请求指纹幂等校验。
- 实现 Resource、MemoryEntity、MemoryEntityBranch、MemoryRelation、ResourceChunk 和 commit effect conflict keys。
- 落后 HEAD 的非冲突操作自动 rebase；等价操作复用已有权威结果。
- 不等价冲突保存为 unresolved `MemoryConflict`，来稿进入系统 conflict branch，目标 branch head 不变。
- append-only commit/operation 历史可以重建 active projection；revert 仍然保留历史。
- 增加 PostgreSQL schema 和驱动无关的 `PostgresCloudMemoryAuthority`，使用 `SELECT ... FOR UPDATE`、同事务 state/log/projection/outbox 写入，并支持进程重启恢复。
- 测试覆盖幂等、幂等键误用、非冲突 rebase、冲突分支、等价写入、投影重建和 PostgreSQL 重启恢复。
