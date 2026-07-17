# HotpotQA 自动记忆评估

本文件说明如何使用 `test/evaluation/` 自动评估 Agent 在 Hermes 中的长期记忆能力。评估固定使用 HotpotQA dev-distractor 的 20 道题，并为每题添加一个动态 mini-NIAH 探针，例如 `KITE-431`。

- HotpotQA 问题衡量内容检索和多跳回答能力。
- mini-NIAH 探针是模型事先不可能知道的随机事实，用于衡量纯记忆召回。
- 本评估是[[本地手动测试.md#本地手动测试]]的附加基准，不能代替 Scenario 0-16、read-only RBAC、forged identity 和 no-sync 的人工验收。
- 实现细节见[`test/evaluation/README.md`](../../test/evaluation/README.md)。

## 运行边界

评估必须遵守以下边界：

- 只使用 `compose.yaml` 和 `compose.hermes.yaml` 中现有的 `hermes-local` 测试容器。
- 复用 `hermes-local-home` 中已经配置的 Hermes provider、model 和 API key。
- runner 只执行普通 `hermes -z ...`，不会传 `--provider`、`--model`，也不会改写 Hermes inference 配置。
- 使用本地 `team_memory` provider 和 `root:test1-local`。
- 不启动 Team Memory HTTP `service`，不调用 sync。
- 使用[[配置文档-local.md#2. 运行 Team Memory setup]]写入的真实 Dev HTTP embedding 配置，不使用 fake/deterministic embedding。
- 完整评估会在开始前清空 Test 1 的现有 Team Memory。不要在仍需保留人工 Scenario 数据时运行。

## 前置条件

先完成[[配置文档-local.md#0. 前置条件]]到[[配置文档-local.md#7. 配置 Hermes 原生设置]]。

检查当前 memory provider：

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local hermes memory status
```

输出必须包含：

```text
Provider:  team_memory
Status:    available
```

同时确认：

- Docker Desktop 正常运行。
- `hermes-local` 能访问配置中的 HTTP embedding 服务。
- Hermes 原生 provider、model 和 API key 已经配置在持久化的 `hermes-local-home` 中。
- Team Memory activation 与 session file 有效。

完整评估还会自动运行 `hermes-local check`。provider、session、activation 或 embedding 无效时应停止测试，不能把环境错误计入模型分数。

## 一键运行完整评估

在仓库根目录执行：

```powershell
npm run eval:memory
```

命令会自动完成：

1. 下载并校验公开的 `hotpot_dev_distractor_v1.json`。文件已存在时只重新校验 size 和 SHA-256。
2. 使用固定 seed `hotpot-memory-v1` 从 7,405 条 dev-distractor 数据中选择同一组 20 题。
3. 为每题生成固定、可复现的 mini-NIAH 探针。
4. build 项目的 `hermes-local` 测试镜像并启动项目 Qdrant。
5. 清空 `root:test1-local` 的旧 History、memory、BM25、CAS 和对应 Qdrant points。
6. 保留 RBAC 与 `/root/.hermes` 中已经配置的 provider、model 和 API key。
7. 自动重新 bootstrap Test 1 root admin 和 main-agent session。
8. 通过 4 次 Hermes one-shot 会话分批写入 20 条记忆，每批 5 题。
9. 使用 20 个全新的 Hermes one-shot 会话逐题调用 `team_memory_search`。
10. 获取 HotpotQA 答案和探针答案，自动评分并保存报告。

评估数据通过 Hermes 正常对话 lifecycle 的 `sync_turn`/session hooks 写入 Team Memory，不会由测试脚本绕过 Hermes 直接写数据库。查询提示明确要求调用 `team_memory_search`。

执行后可用以下日志确认真实工具和 lifecycle 路径：

```text
/root/.hermes/team-memory-tool-calls.jsonl
/root/.hermes/team-memory-hooks.jsonl
```

## 只下载并准备数据

如果只想检查数据，不启动 Docker、不调用 Hermes：

```powershell
npm run eval:memory:prepare
```

生成：

```text
.data/evaluation/hotpotqa/hotpot_dev_distractor_v1.json
.data/evaluation/hotpotqa/hotpotqa-dev-distractor-20.json
```

说明：

- 原始数据和 20 题选择文件都位于 `.data/`，不会提交到 Git。
- 主下载源不可用时使用 commit-pinned、checksum-pinned 的 Hugging Face 镜像。
- 重复执行会得到相同题目、顺序和探针答案。
- 数据集不正确、记录数不是 7,405 或 checksum 不匹配时命令必须失败。

## 一键清空评估记忆

只清空记忆、不运行问答：

```powershell
npm run eval:memory:reset
```

清理范围：

- local Test 1 libSQL 中的 History、memory 和 BM25 表；
- `/workspace/.data/test1-local-hermes/cas`；
- Qdrant 中 `rootEntityId = root:test1-local` 的 points。

明确保留：

- `rbac_*` 用户、角色、assignment 和 credential 数据；
- `hermes-local-home` 中的 provider、model、API key 和其他 Hermes 原生设置；
- 其他 root 的 Qdrant points；
- 已下载的数据集；
- 历史评估报告。

安全限制：reset 只接受[[配置文档-local.md#配置文档-local]]规定的精确 libSQL、CAS 和 Qdrant 地址。路径或 origin 漂移时会拒绝清理，不得绕过该检查。

单独执行 reset 后，如需重新进入人工 Scenario，应按[[配置文档-local.md#4. Bootstrap 本地 root admin]]重新 bootstrap root。完整的 `npm run eval:memory` 已自动包含 bootstrap。

## 结果目录

每轮结果写入：

```text
.data/evaluation/results/<ISO-time>/summary.json
.data/evaluation/results/<ISO-time>/results.json
```

### summary.json

| 字段 | 含义 |
| --- | --- |
| `examples` | 题目总数，应为 `20`。 |
| `datasetExactMatch` | HotpotQA 标准化 exact match 平均值。 |
| `datasetF1` | HotpotQA token F1 平均值；`yes`、`no`、`noanswer` 使用官方特殊规则。 |
| `probeExactMatch` | 20 个动态探针的 exact match 平均值，是最直接的纯记忆指标。 |
| `failedQueries` | Hermes 调用失败或输出无法解析的题数；失败题按零分记录，正常运行应为 `0`。 |
| `hermesInvocations` | harness 启动 Hermes 的次数，当前应为 `24`。它不等于底层模型请求次数。 |
| `estimatedHarnessInputTokens` | 仅估算 harness 构造的输入，不含 Hermes system/tool prompt、召回内容、模型输出或供应商计费 token。 |
| `ingestionDurationMs` | 4 个写入批次的累计耗时。 |
| `queryDurationMs` | 20 个查询的累计耗时。 |
| `wallDurationMs` | 整轮评估墙钟时间。 |
| `runLabel` | 本轮横向比较标签。 |

### results.json

逐题保存：

- 题目 ID 和问题；
- HotpotQA 期望答案和 mini-NIAH 期望答案；
- Hermes 的两个预测答案；
- dataset EM/F1 和 probe exact match；
- 单题耗时和 Hermes exit status；
- `rawOutput`、`rawStderr` 和解析错误。

单题 provider/tool 暂时失败不会丢弃已完成且已付费的其他结果；该题记录错误并按零分计。写入阶段失败则整轮停止，因为后续查询不再有效。

## 横向比较模型或 Agent 版本

横向比较必须保持以下条件相同：

- 数据集和 seed；
- 20 题顺序和探针；
- Team Memory 配置；
- reset 流程；
- embedding provider/model；
- 评分代码版本。

切换推理模型时，使用[[配置文档-local.md#7. 配置 Hermes 原生设置]]中的 Hermes 正常配置入口。不要给评估 runner 增加 provider/model 参数。

可为报告添加标签：

```powershell
$env:HERMES_EVAL_LABEL = "configured-model-a"
npm run eval:memory

$env:HERMES_EVAL_LABEL = "configured-model-b"
npm run eval:memory
```

每次 `eval:memory` 都会先 reset，因此两轮使用同一组 20 题和干净的 `root:test1-local`。比较时至少同时查看：

- `datasetF1`；
- `probeExactMatch`；
- `failedQueries`；
- `wallDurationMs`。

不要把 `hermesInvocations = 24` 当成模型 API 请求次数，也不要把 `estimatedHarnessInputTokens` 当成供应商账单 token。

## 有效运行的通过条件

一轮可用于比较的运行至少满足：

- `examples = 20`；
- `failedQueries = 0`；
- 结果目录同时包含 `summary.json` 和 `results.json`；
- 20 个查询在 tool-call log 中均有 `team_memory_search` 证据；
- hook/lifecycle log 中有 4 个写入批次的 capture 证据；
- 没有启动 Team Memory HTTP `service` 或调用 sync。

分数本身不设通用固定阈值；应先建立同一配置的 baseline，再比较模型、Agent 或记忆实现版本的变化。

## 常见问题

### Provider 不是 team_memory 或 Status 不是 available

回到[[配置文档-local.md#7. 配置 Hermes 原生设置]]，重新检查 Hermes 原生配置和 memory provider。

### hermes-local check 失败

检查：

- Team Memory activation；
- `/root/.hermes/team-memory-session.json`；
- HTTP embedding URL 和模型；
- Qdrant 状态。

### reset 报 unexpected path/origin

当前持久化配置不再是 Test 1 的规定 store。先核对 `/workspace/config/team-memory.hermes-local.json`，不要修改脚本绕过安全检查。

### failedQueries 大于 0

查看对应 `results.json` 中的：

- `rawStderr`；
- `rawOutput`；
- `error`；
- `hermesExitStatus`。

再对照：

```text
/root/.hermes/team-memory-tool-calls.jsonl
/root/.hermes/team-memory-hooks.jsonl
```

### 数据下载失败

重新执行：

```powershell
npm run eval:memory:prepare
```

如果主源和 pinned mirror 都不可用，保留错误信息并稍后重试；不要手工放入未校验的同名文件。
