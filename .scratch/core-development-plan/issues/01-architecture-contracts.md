# 架构与接口契约

Status: ready-for-human

## 目标

在正式实现前，先确定 RBAC、Memory、Agent Runtime 之间的模块边界和接口契约。

## 范围

- 将 `../DESIGN-NOTES.md` 中的数据结构和建模决策纳入 contract tests。
- 使用 TypeScript 定义 RBAC、Memory、PermissionRouter 和 MemoryAdapter 的核心契约。
- 为跨语言适配生成 JSON Schema / OpenAPI 契约，避免 Python 适配器手工维护另一套模型。
- 定义 RBAC 对外接口。
- 定义 Memory 对外接口。
- 定义 PermissionRouter request / response。
- 定义 MemoryAdapter 的授权请求类型。
- 添加 User、Agent、Role、RootEntity、TaskScope、MemoryObject fixtures。
- 添加授权管线 contract tests。

## 验收标准

- RBAC 实现不依赖 Memory 存储内部细节。
- Memory 实现不依赖 RBAC role assignment 内部细节。
- PermissionRouter 接收 user / agent 请求后，先调用 PolicyEngine，再把已授权请求转给 MemoryAdapter。
- 契约中包含 subject、rootEntityId、action、resourceKind、branchRef、taskScope 等必要字段。
- 管理员级动作和普通记忆动作在模型中明确区分。
- contract tests 覆盖 `MemoryRelationType` 白名单、`extraInfo` 边界、RootEntity `rootEntityId = null`、非 MemoryEntity 对象 `rootEntityId` 非空等约束。
- TypeScript 核心契约和生成的语言中立契约具有自动化一致性测试。
- Python Hermes 适配器能够消费生成契约，但不包含 PolicyEngine 或 Memory 写入规则的副本。

## 备注

这个 issue 必须最先做。该项目最重要的架构承诺就是 RBAC 和 Memory 解耦。

## Comments

### 2026-06-25 Implementation

- 建立 TypeScript 工程、严格类型检查和 Node 原生测试基线。
- 定义 Memory、RBAC、PolicyEngine、PermissionRouter 和 MemoryAdapter 公共契约。
- 添加 RootEntity、非空 rootEntityId、关系白名单和 extraInfo 边界校验。
- 添加用户、Agent、角色、TaskScope 与 L1/L2/L3 fixtures。
- 添加允许与拒绝授权管线 contract tests；拒绝请求不会进入 MemoryAdapter。
- 生成 `contracts/team-memory-rbac.schema.json`，并测试其与 TypeScript 运行时契约一致。
- 添加 Python Hermes 契约加载器 smoke test；Python 层不包含领域规则。
- `npm run check` 通过：TypeScript typecheck、8 个 Node tests、1 个 Python test。
