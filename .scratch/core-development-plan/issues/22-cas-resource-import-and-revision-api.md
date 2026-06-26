# CAS 资源导入、修订与内容读取闭环

Status: ready-for-agent

## What to build

提供经授权的资源导入和读取路径：原始内容写入 CAS，Resource 只保存引用与 hash；修订追加新的 content hash 与 History operation，读取时只能取回当前 subject 被允许访问的原始内容。

## Acceptance criteria

- [ ] 授权导入把原始 bytes 写入 CAS，并创建可审计的 Resource/revision 历史。
- [ ] 修订不覆盖旧 CAS 对象或旧 revision。
- [ ] 授权读取可按 Resource/Revision 返回内容；越权请求不泄露存在性或内容。
- [ ] tombstone 后默认不可读，revert/replay 后行为与 History 一致。
- [ ] CAS 断连、hash 不一致与重复上传有可验证错误语义和集成测试。

## Blocked by

- Issue 19 - 本地可运行开发栈与服务健康检查
- Issue 20 - 持久化 RBAC、身份认证与管理员 CLI
- Issue 21 - libSQL History Authority 生产适配器
