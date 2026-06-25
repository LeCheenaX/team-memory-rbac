# Agent Session 身份上下文

Status: ready-for-human

## What to build

实现受信任的 Agent session 身份链路，使 Agent 调用记忆模块时无需依赖模型 prompt 或工具参数携带 userId。

HTTP、MCP 和原生 runtime 适配器先验证登录凭证或 session token，再在服务端解析 PrincipalContext。Agent 请求中的 owner user 必须从 AgentIdentity 和 session 查得，不能信任模型或客户端自由填写的 ownerUserId。

## Acceptance criteria

- [ ] PrincipalContext 至少包含 sessionId、userId、agentId、rootEntityId、TaskScope，以及适用时的 delegationId 和 parentAgentId。
- [ ] session token 只携带不可伪造的 session reference 或受签名 claims；服务端仍验证用户、Agent 和 delegation 当前状态。
- [ ] Memory SDK 和工具 handler 从受信任 transport/session context 构造 PermissionRequest。
- [ ] Agent 工具 schema 不要求模型提供 userId 或 ownerUserId。
- [ ] AgentIdentity.ownerUserId 与 session userId 不一致时拒绝请求。
- [ ] 禁用 user、禁用 Agent、撤销 delegation、session 过期或 TaskScope 缺失时，下一次调用失败。
- [ ] rootEntityId 和 TaskScope 不能被工具参数扩大到 session 授权范围之外。
- [ ] 每个 Agent memory operation 的审计信息可以追溯 sessionId、agentId、owner user 和 delegation。
- [ ] HTTP、MCP、OpenClaw 和 Hermes 可以映射到同一个 PrincipalContext 契约。
- [ ] 测试覆盖伪造 userId、伪造 ownerUserId、跨 root 调用、过期 session、撤销 delegation 和正常 session 调用。

## Blocked by

- Issue 03 - Policy Engine 与 Permission Router
- Issue 06 - 授权检索契约与可替换查询源

## Comments

### 2026-06-25 Implementation

- 增加生成契约中的 `PrincipalContext`，包含 session、user、Agent、root、TaskScope、delegation 和 parent Agent。
- 实现不可猜测 opaque token 的 `InMemoryAgentSessionAuthority`。
- session 创建和每次解析都会验证 user、Agent、owner 关系、delegation、parent Agent、root、TaskScope 和过期状态。
- 禁用 user/Agent、撤销 delegation、撤销 session 或 token 过期会使下一次调用失败。
- `permissionRequestFromPrincipal` 只从受信任 PrincipalContext 构造 subject、root 和 TaskScope，并拒绝工具输入覆盖身份字段。
- Memory operation 增加可选 provenance，Agent 写入可追溯 sessionId、ownerUserId、delegationId 和 parentAgentId。
- HTTP、MCP、OpenClaw、Hermes、Claude Code 和 Codex 共享同一 PrincipalContext 映射。
- Hermes Python 只映射生成契约，不包含 RBAC 或 Memory 领域判断。
- 测试覆盖伪造 token/owner、跨 root、过期、撤销 delegation、禁用 user/Agent 和审计追溯。
