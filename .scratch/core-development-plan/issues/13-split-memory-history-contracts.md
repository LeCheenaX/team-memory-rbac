# 拆分 Memory 与 History 契约

Status: ready-for-human

## 目标

把现有代码中混在一起的 Memory 当前状态契约和 History 审计/版本契约拆开，防止 Memory 模块继续拥有 commit、operation、rollback、replay、conflict 或 sync cursor。

## 背景

当前 `src/contracts/memory.ts` 同时定义了：

- Memory 当前状态对象：`MemoryEntity`、`MemoryEntityBranch`、`MemoryRelation`、`Resource`、`ResourceChunk`
- History 对象：`MemoryBranch`、`MemoryCommit`、`MemorySnapshot`
- 状态对象上的 History 字段：`MemoryEntityBranch.commitId`、`MemoryRelation.commitId`、`ResourceRevision.commitId`

当前 `src/memory/contracts.ts` 也同时定义了 write command、operation、active view 和 seed。这与最终方案冲突：

```txt
Memory:
  当前可检索、可读写的记忆状态

History:
  操作历史、审计、撤回、回放、冲突、合并、分支头
```

## 范围

- 新增 `src/contracts/history.ts`。
- 将 `MemoryBranch`、`MemoryCommit`、`MemorySnapshot`、`MemoryOperationKind`、`MemoryOperation`、operation input、conflict / resolution 相关契约迁入 History 契约。
- 从 Memory 当前状态对象中移除强制 `commitId` 依赖。
- 保留 History event / sync envelope 携带来源 commit 的能力，但不让 Memory caller 通过 Memory 对象反查 History。
- 更新生成的 JSON Schema。
- 更新 TypeScript 和 Python contract tests。

## 验收标准

- `MemoryEntityBranch` 不再要求 `commitId`。
- `MemoryRelation` 不再要求 `commitId`。
- `ResourceRevision` 属于 History 契约，而不是 Memory 当前状态契约。
- Memory contract tests 只验证当前状态对象的 root ownership、关系语义和 payload 约束。
- History contract tests 验证 commit、operation、branch head、revert、resolution 的结构。
- `npm run check` 通过。

## 备注

`InMemoryMemoryAuthority` 可以暂时保留，但应被标记为旧的 combined reference implementation，后续 issue 会拆成 Memory projector 和 History authority。

## Comments

### 2026-06-26 Implementation

- 已在提交 `600ab33` 完成契约拆分、生成 schema 与回归测试。
- `npm run check` 通过。
