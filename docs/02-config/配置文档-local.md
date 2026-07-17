# 配置文档-local

本文件从操作者视角描述本地 Hermes/Team Memory 怎么在 PowerShell 里一步步配置。不要手工编辑 Team Memory JSON。配置必须通过 `team -- --config ... setup` 交互式流程写入并激活。

相关测试：[[本地手动测试.md#本地手动测试]]。

## 测试环境一键维护

两个命令都必须通过 `-Target` 指定唯一目标；可选值只有 `hermes-local`、`hermes-a`、`hermes-b`。脚本不会同时启动三套 Hermes。

只重新构建指定目标中的最新版 Team Memory：

```powershell
npm.cmd run hermes:test:redeploy -- -Target hermes-local
npm.cmd run hermes:test:redeploy -- -Target hermes-a
npm.cmd run hermes:test:redeploy -- -Target hermes-b
```

完全禁用 Docker 构建缓存时，在同一命令后增加 `-NoCache`：

```powershell
npm.cmd run hermes:test:redeploy -- -Target hermes-local -NoCache
```

`hermes-local` 只构建和验证 local 镜像。`hermes-a` 或 `hermes-b` 会同时构建它依赖的共享 `service` 镜像，但不会启动 service、基础设施或另一个 Hermes 客户端。

只清空指定测试目标的非核心记忆：

```powershell
npm.cmd run hermes:test:clear-memory -- -Target hermes-local
npm.cmd run hermes:test:clear-memory -- -Target hermes-a
npm.cmd run hermes:test:clear-memory -- -Target hermes-b
```

- 指定 `hermes-local`：只清理 Test 1 local 的 History、relation、BM25、Qdrant collections 和 filesystem CAS。
- 指定 `hermes-a` 或 `hermes-b`：清理 Test 2 的共享 server memory。A/B 使用同一个 server memory，因此选择任一客户端都会让另一个客户端看到同样的清空结果，但脚本不会启动另一个 Hermes 客户端。
- 清理所需的基础设施只在执行期间启动，完成后停止；脚本不会把整套测试容器留在同时运行状态。

清理不会删除任何 `rbac_*` 数据，因此用户、密码凭据、管理员、Agent、角色、授权、delegation、session 和 RBAC audit log 都会保留。不要使用 `docker compose down -v` 代替此命令。

## 0. 前置条件

在仓库根目录执行：

```powershell
npm.cmd install
npm.cmd run check
docker compose -f compose.yaml -f compose.hermes.yaml build hermes-local hermes-a hermes-b
```

准备一个 Hermes 容器可访问的真实 HTTP embedding 服务。默认测试 URL 是：

```text
http://host.docker.internal:11434/api/embeddings
```

`unitTest` 才允许 fake embedding。`Dev` 和 `Production` 必须使用真实 HTTP embedding provider。

## 1. 启动本地基础设施

Test 1 只启动 Qdrant，不启动 Team Memory HTTP service。

```powershell
docker compose up -d qdrant
```

不要在 setup 前把 `hermes-local check` 当成通过条件。setup 前它应该因为 memory module 尚未激活而失败。

## 2. 运行 Team Memory setup

在 Hermes local 容器内运行 setup。这个命令会读取模板，并把激活后的配置写入持久化的 `/workspace/config/team-memory.hermes-local.json`。

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local npm --prefix /opt/team-memory-rbac run team -- --config /workspace/config/team-memory.hermes-local.json setup
```

交互提示里按测试环境输入：

| 提示                 | Test 1 输入                                              |
| ------------------ | ------------------------------------------------------ |
| runtime mode       | `Dev`                                                  |
| embedding provider | `http`                                                 |
| embedding URL      | 容器可访问的 HTTP embedding URL                              |
| embedding model    | 当前 embedding 服务中真实存在的模型                                |
| libSQL             | 使用提示给出的 local/libSQL 测试路径                              |
| CAS                | 使用提示给出的 local filesystem CAS 路径                        |
| Qdrant             | 使用提示给出的 local Qdrant 地址                                |
| recall top-P       | 默认 `0.8`；控制 recall 结果覆盖的分数比例，Agent 的 `limit` 仍只是返回数量上限 |
| optional settings  | 没有特殊需求就接受默认值                                           |

通过条件：

- setup 会验证 embedding model。
- 验证成功后写入 activation record。
- 没有 activation record 的配置必须视为 inactive。

## 3. 检查 Hermes 与 Team Memory 激活状态

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local check
```

通过条件：

- Hermes binary 可用。
- Team Memory adapter 可导入。
- Hermes plugin 已安装。
- Team Memory runtime 已激活。

## 4. Bootstrap 本地 root admin

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local npm --prefix /opt/team-memory-rbac run bootstrap:root-admin -- --config /workspace/config/team-memory.hermes-local.json
```

按提示输入本轮测试的 root admin 密码。该命令会登录 `user:test1-admin`，并写入：

```text
/root/.hermes/team-memory-session.json
```

Hermes 后续应直接使用这个 session file。不要让操作者手工复制 agent token。

## 5. 验证用户登录流程

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local npm --prefix /opt/team-memory-rbac run team -- --config /workspace/config/team-memory.hermes-local.json login
```

输入：

```text
user:test1-admin
<bootstrap 时设置的密码>
```

通过条件：命令返回 `logged_in`，session file 中包含 human user session 和 main-agent session。

## 6. 创建只读用户

仍然用管理员 session 创建 read-only 用户。真正的 RBAC 拒绝要在后续 Hermes 对话里验证。

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local npm --prefix /opt/team-memory-rbac run team -- --config /workspace/config/team-memory.hermes-local.json members create user:test1-readonly Test1ReadOnly role-researcher
```

按提示输入只读用户密码。

切换身份时使用：

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local npm --prefix /opt/team-memory-rbac run team -- logout
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local npm --prefix /opt/team-memory-rbac run team -- --config /workspace/config/team-memory.hermes-local.json login
```

## 7. 配置 Hermes 原生设置

这些是 Hermes 自己的配置，写在 `/root/.hermes` Docker volume 中。

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local hermes setup
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local hermes config
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local hermes memory setup team_memory
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local hermes memory status
```

通过条件：

- `hermes memory status` 显示 `Provider: team_memory`。
- plugin installed/available。
- Team Memory 只在 session file 有效且 main-agent 有 `memory.catalog` 权限时报告 available。

## 8. 启动真实 Hermes 会话

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local hermes
```

从这里开始才算手动验收会话。保存完整 transcript。shell 命令只能做 setup 或诊断，不能替代 Hermes 对话测试。

## 9. 采集日志

日志路径以 Scenario 16 返回为准。常见路径：

```text
/root/.hermes/team-memory-hooks.jsonl
/root/.hermes/team-memory-tool-calls.jsonl
```

需要诊断时可读取容器内日志：

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local sh -lc "tail -n 200 /root/.hermes/team-memory-tool-calls.jsonl"
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local sh -lc "tail -n 200 /root/.hermes/team-memory-hooks.jsonl"
```

本地手测必须把 transcript、tool-call log、hook/lifecycle log 一起保存，并按[[本地手动测试.md#Log 对账规则]]比对。
