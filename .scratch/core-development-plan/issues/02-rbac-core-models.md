# RBAC 核心模型

Status: ready-for-human

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

## Comments

### 2026-06-25 Implementation

- 实现 User、AgentIdentity、Role、Permission、UserRootRoleAssignment、AgentDelegation 和 TaskScope 契约。
- 提供 researcher、curator、resource importer、maintainer、root admin 内置角色目录。
- 使用显式 action-resource 矩阵，避免角色产生无意义或过宽的权限组合。
- 自定义角色校验覆盖空角色、重复权限、非法约束和非法 action-resource 组合。
- Agent delegation 校验并在 PolicyEngine 中强制保持为 owner user 权限子集。
- scoped authority 支持同一用户在同一 RootEntity 多角色、不同 RootEntity 不同角色。
- TaskScope 支持 entity、resource、tag、relation type 和 relation depth 收窄。
- RBAC 模型已同步到生成的 JSON Schema，供 Python Hermes 适配器消费。
