# RBAC 核心模型

Status: ready-for-agent

## 目标

实现 scoped RBAC 领域模型。

## 范围

- User
- AgentIdentity
- Role
- Permission
- UserRootRoleAssignment
- AgentDelegation
- TaskScope
- PermissionDecision
- 内置角色目录
- 自定义角色校验

## 验收标准

- 一个 user 可以在不同 rootEntityId 下拥有不同 role。
- 一个 user 可以在同一 rootEntityId 下拥有多个 role。
- Role 只定义 action 和 resourceKind，不直接绑定项目。
- UserRootRoleAssignment 具备 assignedBy、assignedAt、status、revokedAt、expiresAt 等生命周期字段。
- AgentDelegation 只能委派 owner user 权限的子集。
- TaskScope 可以按 allowedEntityIds、deniedEntityIds、allowedTags、deniedTags、relation type、relation depth 收窄。

## 优先级

核心。必须在大范围记忆写入 API 前完成。
