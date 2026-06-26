# 文档摄取、切块、Embedding 与 BM25 管道

Status: ready-for-agent

## What to build

从已导入 Resource 建立可重试的摄取流水线：解析内容、生成 ResourceChunk、生成 embedding、写入 Qdrant，并建立 BM25 文本索引。流水线失败可恢复，不绕过 History 与授权边界。

## Acceptance criteria

- [ ] 支持至少 document、conversation、code_file 与 tool_output 的切块。
- [ ] 每个 chunk 保存可验证的 content hash、位置 metadata 和来源 Resource。
- [ ] embedding 与 BM25 索引可重建，不充当权威数据。
- [ ] 同一 revision 重跑幂等；失败任务可以重试且不会留下半完成可检索状态。
- [ ] 授权 keyword 与 semantic 检索可返回同一资源的 evidence。

## Blocked by

- Issue 22 - CAS 资源导入、修订与内容读取闭环
- Issue 23 - Qdrant 与 libSQL Relation Store 授权检索闭环
