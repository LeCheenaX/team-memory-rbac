# 降级 PostgreSQL CloudMemoryAuthority 为 legacy prototype

Status: ready-for-human

## 目标

将当前 PostgreSQL adapter 从目标生产方向中移除，明确标记为旧模型 prototype / compatibility adapter，避免后续实现继续沿着 Postgres JSONB active projection 方案扩展。

## 背景

当前 `adapters/postgres/cloud-memory-authority.ts`：

- 使用 `InMemoryCloudMemoryAuthority` 作为 delegate
- 将完整 authority state 作为 JSONB 存入 `team_memory_authority_state`
- 将 active projection 作为 JSONB 存入 `team_memory_active_projections`
- 将 commit / operation payload 作为 JSONB 存储

这与最终方案冲突：

```txt
Memory:
  CAS + Qdrant + libSQL relation store

History:
  libSQL commits / operations / branch heads / conflicts / resolutions
```

## 范围

- 将 `adapters/postgres/` 标记为 legacy prototype。
- 更新测试名称和注释，说明它只验证旧 reference behavior，不代表目标存储。
- 防止新代码依赖 `PostgresCloudMemoryAuthority` 作为生产 adapter。
- 如有必要，将其移动到 `adapters/legacy-postgres/` 或 `test/support/legacy-postgres/`。
- 在 docs 或 issue 中指向新目标 adapter：
  - Qdrant Memory state
  - libSQL MemoryRelation
  - libSQL History
  - CAS Resource

## 验收标准

- PRD 和 DesignNote 不再把 PostgreSQL 写作目标存储。
- `PostgresCloudMemoryAuthority` 不再出现在主导出路径中。
- Postgres tests 如保留，命名中明确包含 legacy/prototype。
- 新 adapter work 不以 Postgres JSONB active projection 为基础。
- `npm run check` 通过。

## Comments

### 2026-06-26 Implementation

- 已在提交 `9210b9c` 将 PostgreSQL JSONB authority 移至 `legacy-postgres`，并重命名为 compatibility prototype。
- `npm run check` 通过。
