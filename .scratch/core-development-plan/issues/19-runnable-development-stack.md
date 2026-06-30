# 本地可运行开发栈与服务健康检查

Status: complete

## What to build

提供一个可在开发机一条命令启动的最小服务栈：libSQL、Qdrant、CAS 兼容对象存储和 TypeScript 服务。操作者可以完成一次已认证的 RootEntity 初始化、资源写入和授权读取，并通过 health/readiness endpoint 判断各依赖是否可用。

## Acceptance criteria

- [ ] Docker Compose（或等价开发编排）能启动全部必需依赖和服务。
- [ ] 配置只从显式环境变量/配置文件读取，提供无密钥示例。
- [ ] 服务提供 liveness 与 dependency readiness 检查。
- [ ] 初始化命令能创建用于开发的 RootEntity 和管理员身份。
- [ ] 端到端 smoke test 在空环境验证启动、写入和授权读取。

## Blocked by

None - can start immediately.

## Comments

- Completed with `compose.yaml`, explicit `.env.example` configuration, `dev:init` / `dev:server`, and `/live` plus dependency-aware `/ready` endpoints.
- `test/production-stack.test.ts` covers an empty local stack bootstrap, authenticated import, and authorized HTTP read.
