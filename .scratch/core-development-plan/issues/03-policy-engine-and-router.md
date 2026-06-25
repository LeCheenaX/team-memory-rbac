# Policy Engine 与 Permission Router

Status: ready-for-agent

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
