# Agent Session 身份上下文

Status: ready-for-agent

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
