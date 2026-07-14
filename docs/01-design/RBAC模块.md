# RBAC 模块

RBAC 模块只回答权限问题：某个 authenticated subject 在某个 `rootEntityId`、`taskScope` 和 delegation 下，能否对某类资源执行某个动作。它不理解记忆正文，不合并事实，不写 History。记忆对象字段见[[记忆模块.md#MemoryEntity]] 和[[记忆模块.md#MemoryEntityBranch]]。

代码出处：`src/contracts/rbac.ts`、`src/rbac/permissions.ts`、`src/rbac/policy-engine.ts`、`src/rbac/validation.ts`、`src/rbac/authority.ts`、`src/rbac/catalog.ts`、`src/rbac/index.ts`、`src/permission-router.ts`、`src/adapters/libsql/rbac-authority.ts`、`src/adapters/libsql/rbac-schema.sql`、`src/adapters/cli/team-management.ts`。

本模块术语：

| 名称 | 含义 |
| --- | --- |
| authenticated subject | 已通过 transport/session 认证的调用主体，可以包含用户、Agent 和 delegation。它不是 payload 里的自报身份。 |
| `rootEntityId` | 当前长期记忆空间的根 id，由 trusted session 决定；普通 Agent tool call 不能覆盖。 |
| `taskScope` | 当前任务允许访问的标签/项目范围，用于把同一 root 下的权限再收窄。 |
| delegation | 用户授予 Agent 的权限子集，只能缩小用户权限，不能扩大用户权限。 |
| resource kind | 权限判断使用的资源类别，例如 `memory_entity`、`resource`、`memory_relation`。它不是具体对象 id。 |

## PrincipalContext

`PrincipalContext` 表示当前调用者和 trusted session。用户、Agent、root、task scope 都来自认证层或 host session，不由普通 Agent tool call 参数覆盖。

必须字段：`userId`、`agentId`、`rootEntityId`、`taskScope`。

可选字段：`delegationId`、`sessionId`、`host`。

字段含义：

| 字段 | 含义 |
| --- | --- |
| `userId` | 当前人类用户 id，由登录/session 解析。 |
| `agentId` | 当前 Agent 或工具客户端 id，由 host/adapter 解析。 |
| `rootEntityId` | 当前记忆 root，由 trusted session 绑定。 |
| `taskScope` | 当前任务的授权范围，通常是项目/tag 列表。 |
| `delegationId` | 本次 Agent 调用使用的 delegation id。 |
| `sessionId` | host 会话 id，用于审计和 provenance。 |
| `host` | 调用来自哪个 host/adapter，例如 Hermes、OpenClaw、Codex。 |

示例调用：

```json
{
  "userId": "user:lex",
  "agentId": "agent:hermes",
  "rootEntityId": "root:riverfront",
  "taskScope": ["project:riverfront"],
  "host": "hermes"
}
```

预期结果：RBAC 可基于该 context 计算 effective permissions；如果 tool payload 另带 `userId` 或 `rootEntityId` override，Gateway 必须拒绝。

## Role

`Role` 是权限集合的命名模板。内置角色和自定义角色都只描述 permission，不描述 memory content。

必须字段：`name`、`permissions`。

可选字段：`description`、`tags`、`status`。

字段含义：

| 字段 | 含义 |
| --- | --- |
| `name` | 给人看的角色名。 |
| `permissions` | 该角色包含的权限条目列表。 |
| `description` | 管理员可读说明，不参与授权计算。 |
| `tags` | 管理/筛选角色用的标签，不等同于 memory tag 过滤条件。 |
| `status` | 角色是否可用，例如 active/disabled。 |

示例调用：

```json
{
  "name": "memory_writer",
  "permissions": ["search:memory_entity", "write:memory_entity"]
}
```

预期结果：role 可被分配到 user/root；Agent 仍只能继承 delegation 允许的子集。

## Permission

权限由 action、resource kind、scope 和可选 relation/tag 条件组成。

必须字段：`action`、`resourceKind`。

可选字段：`tagsAny`、`tagsAll`、`relationTypes`、`taskScope`。

字段含义：

| 字段 | 含义 |
| --- | --- |
| `action` | 要执行的动作，例如 read/search/write/import/admin。 |
| `resourceKind` | 动作作用的资源类别。 |
| `tagsAny` | 至少匹配其中一个 tag 才允许访问。 |
| `tagsAll` | 必须同时匹配所有 tag 才允许访问。 |
| `relationTypes` | 允许访问或展开的 relation type 集合。 |
| `taskScope` | 该 permission 额外限制的任务范围。 |

示例调用：

```json
{
  "action": "search",
  "resourceKind": "memory_entity",
  "tagsAny": ["project:riverfront"]
}
```

预期结果：只允许读取符合 tag/scope 的候选；过滤逻辑在 retrieval 前后都要生效。

## AgentDelegation

Agent delegation 是用户权限的子集，不能扩大用户权限。A-to-A 或 host
delegation 的稳定句柄是 delegation/task id 加上本次任务需要的
`permissions`；只有 host 已经明确选择具体 sub-agent 时才填写 `agentId`。

必须字段：`id`、`rootEntityId`、`permissions`。

可选字段：`agentId`、`expiresAt`、`taskScope`、`revokedAt`。

字段含义：

| 字段 | 含义 |
| --- | --- |
| `id` | delegation/task 的稳定授权句柄。 |
| `agentId` | 被授权的具体 Agent id；未选择具体 sub-agent 时省略。 |
| `rootEntityId` | delegation 生效的记忆 root。 |
| `permissions` | Agent 可使用的权限子集。 |
| `expiresAt` | delegation 自动失效时间。 |
| `taskScope` | delegation 允许的任务范围。 |
| `revokedAt` | delegation 被撤销的时间；存在时视为不可用。 |

示例调用：

```json
{
  "id": "delegation:riverfront-weekly-report",
  "agentId": "agent:hermes",
  "rootEntityId": "root:riverfront",
  "permissions": ["search:memory_entity", "write:memory_entity"],
  "taskScope": ["project:riverfront"]
}
```

预期结果：effective permission = user permission at root ∩ agent delegation ∩ task scope。

## PermissionDecision

`PermissionDecision` 是授权结果。

必须字段：`allowed`。

可选字段：`reason`、`missingPermissions`、`filteredTags`、`decisionId`。

字段含义：

| 字段 | 含义 |
| --- | --- |
| `allowed` | 是否允许继续执行目标动作。 |
| `reason` | 拒绝或降级的原因代码。 |
| `missingPermissions` | 缺少哪些 permission。 |
| `filteredTags` | 授权过滤后实际可见的 tag 范围。 |
| `decisionId` | 本次授权决策 id，用于 audit record 关联。 |

示例结果：

```json
{
  "allowed": false,
  "reason": "missing_permission",
  "missingPermissions": ["write:memory_entity"]
}
```

预期结果：Gateway 返回权限拒绝，不进入[[记忆模块.md#AgentFacingCaptureInput]] 的写入路径。

## PermissionRouter

`PermissionRouter` 是运行时入口和核心模块之间的授权边界。根据[[运行时适配器模块.md#TeamMemoryGateway]]，Gateway 先认证 token，再调用 router，然后才进入 memory/history/resource 服务。

字段含义：

| 字段 | 含义 |
| --- | --- |
| `action` | Gateway 请求授权的动作。 |
| `resourceKind` | 该动作作用的资源类别。 |
| `query` | 搜索时的自然语言查询，只用于授权上下文和审计，不用于判断语义正确性。 |
| `tagsAny` | 搜索/写入请求希望使用的 tag 过滤条件。 |
| `operationTargets` | 写入 batch 将触及的对象类别列表。 |
| `effectiveScope` | Router 计算后的实际授权范围。 |

示例调用：

```json
{
  "action": "search",
  "resourceKind": "memory_entity",
  "query": "Riverfront OpenClaw",
  "tagsAny": ["project:riverfront"]
}
```

预期结果：

```json
{
  "allowed": true,
  "effectiveScope": {
    "rootEntityId": "root:riverfront",
    "tagsAny": ["project:riverfront"]
  }
}
```

写入示例：

```json
{
  "action": "write",
  "resourceKind": "memory_entity",
  "operationTargets": ["memory_entity", "memory_entity_branch", "memory_relation"]
}
```

预期结果：允许后进入[[操作记录模块.md#MemoryCommit]]；拒绝则没有 commit、没有 active view 变化。

## RbacAuthority

`RbacAuthority` 持久化 user/root/role/delegation/audit。管理员动作不能由普通 Agent 自动执行。

字段含义：

| 字段 | 含义 |
| --- | --- |
| `action` | 管理动作，例如 `assign_role`。 |
| `userId` | 被管理的人类用户 id。 |
| `rootEntityId` | 角色分配生效的记忆 root。 |
| `role` | 要分配的 role 名称或 id。 |
| audit record | 管理动作产生的审计记录，见[[操作记录模块.md#AuditRecord]]。 |

示例调用：

```json
{
  "action": "assign_role",
  "userId": "user:mina",
  "rootEntityId": "root:riverfront",
  "role": "reader"
}
```

预期结果：写入 RBAC audit record；后续搜索只获得 reader 权限。

## TeamManagementCli

团队管理 CLI 是人工管理员入口，不是普通 Agent workflow 的一部分。

字段含义：

| 字段 | 含义 |
| --- | --- |
| `team-memory team assign-role` | 管理员分配角色的 CLI 命令。 |
| user 参数 | 被分配角色的用户 id。 |
| root 参数 | 角色生效的记忆 root。 |
| role 参数 | 被分配的角色名或 id。 |

示例调用：

```text
team-memory team assign-role user:mina root:riverfront reader
```

预期结果：更新 RBAC authority，并生成 audit record；不修改 memory facts。
