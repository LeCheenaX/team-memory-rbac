# libSQL History Authority 生产适配器

Status: ready-for-agent

## What to build

用 libSQL 实现 Cloud History shared authority：真实持久化 commit、operation、branch head、conflict、resolution 与 sync watermark，并让提交、幂等校验与 branch 更新具备事务语义。

## Acceptance criteria

- [ ] Cloud History 重启后保留完整 operation tree、head、conflict 和 resolution。
- [ ] expectedHeadCommitId 与 clientMutationId 的并发/幂等语义在 libSQL 事务中生效。
- [ ] conflict branch 不改变目标 branch head，resolution commit 明确引用 conflict 与 incoming commit。
- [ ] replay 可持续生成给 Memory projector 消费的事件序列。
- [ ] 内存 History authority 仅保留为测试 adapter，生产组装不依赖它。

## Blocked by

- Issue 19 - 本地可运行开发栈与服务健康检查
- Issue 20 - 持久化 RBAC、身份认证与管理员 CLI
