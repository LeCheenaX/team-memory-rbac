# Policy Engine 与 Permission Router

Status: ready-for-human

## 目标

实现权限计算和阻止未授权记忆访问的路由层。

## 范围

- PolicyEngine
- PermissionRouter
- effective permission 计算
- missing permission 报告
- Agent 执行管理员动作时拒绝
- permission cache interface
- audit log interface

## 验收标准

- `UserPermissionAtRoot` 由 active UserRootRoleAssignment 计算得出。
- `AgentEffectivePermission` 是 user scoped permissions、AgentDelegation、TaskScope 的交集。
- PermissionDecision 包含 allowed、reason、subjectId、subjectKind、rootEntityId、action、resourceKind、matchedRoles、missingActions、constraints。
- PermissionRouter 不会把 denied request 转发给 MemoryAdapter。
- 即使 owner user 有高权限，Agent 也不能自动执行管理员级动作。
- 测试覆盖只读 ResearchAgent、CuratorAgent、ResourceImporter、Maintainer 和被拒绝的 admin 操作。

## 优先级

核心。这是读写安全的主闸门。

## Comments

### 2026-06-25 Implementation

- 实现 `ScopedPolicyEngine` 和只读 `RbacAuthority` interface。
- 用户有效权限由当前 RootEntity 下 active、未过期 assignment 的角色并集计算。
- Agent 有效权限由 owner 权限、active delegation 和 TaskScope 交集计算。
- Agent 缺少 TaskScope 时拒绝；Agent 管理员动作无条件拒绝。
- PermissionDecision 返回原因、匹配角色、缺失动作和最终约束。
- 增加 permission cache interface，包含按 subject + RootEntity 失效入口。
- 增加 audit log interface；缓存命中也会记录权限决定。
- PermissionRouter 已通过真实 PolicyEngine 集成测试，拒绝请求不会调用 MemoryAdapter。
- 覆盖 Research、Curator、Resource Importer、Maintainer 和管理员动作拒绝场景。
- `npm run check` 通过：TypeScript typecheck、18 个 Node tests、1 个 Python test。
