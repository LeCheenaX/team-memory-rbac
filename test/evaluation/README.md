# Hermes memory evaluation

This harness evaluates the project's configured `hermes-local` test container with 20 deterministic examples from the HotpotQA dev-distractor split. Each example contains the original ten paragraphs plus a generated mini-NIAH probe such as `KITE-431`.

## Prerequisite

Complete [`docs/02-config/配置文档-local.md`](../../docs/02-config/配置文档-local.md) once. In particular, `hermes-local-home` must already contain the Hermes provider, model, API key, and active `team_memory` provider. The evaluation never selects, overrides, or reconfigures the Hermes inference provider/model.

The configured HTTP embedding service must also be reachable from `hermes-local`, as required by the project's Dev setup.

## One-command run

```powershell
npm run eval:memory
```

The command:

1. downloads and verifies the public HotpotQA dataset;
2. builds and starts the existing `hermes-local` test container and project Qdrant;
3. clears only the `root:test1-local` Team Memory state while preserving `/root/.hermes` provider/model/API-key configuration;
4. bootstraps a fresh local test session;
5. verifies `hermes-local check` and `hermes memory status`;
6. writes 20 records in four Hermes conversations, then asks 20 questions in fresh conversations;
7. scores replies and writes reports under `.data/evaluation/results/`.

The runner calls plain `hermes -z ...`; it deliberately supplies no provider, model, or unsupported turn-limit flags. To compare configured models, change Hermes through the project's normal configuration flow, set an optional report label, and rerun the same benchmark:

```powershell
$env:HERMES_EVAL_LABEL = "my-configured-model"
npm run eval:memory
```

## One-command memory reset

```powershell
npm run eval:memory:reset
```

Reset clears the local Test 1 History/memory/BM25 tables, its filesystem CAS, and Qdrant points whose `rootEntityId` is `root:test1-local`. It refuses any libSQL, CAS, or Qdrant path other than the exact documented `hermes-local` stores. It preserves RBAC data, the `hermes-local-home` configuration (provider, model, API keys), downloaded dataset, result reports, and unrelated Qdrant roots. `eval:memory` bootstraps the root entity again immediately after this reset.

## Metrics and cost controls

- HotpotQA answer exact match and token F1 follow the official normalized answer rules, including special handling for `yes`, `no`, and `noanswer`.
- Probe exact match measures whether a synthetic fact that cannot be known beforehand was recalled.
- Batching keeps the harness to four ingestion plus 20 query Hermes invocations. A query can require multiple underlying model turns for tool use, so this is not reported as 24 model calls.
- The summary records wall time, per-phase time, run label, and `estimatedHarnessInputTokens` (only the prompts built by this harness). Hermes system/tool prompts, retrieved content, outputs, and provider-billed usage are explicitly excluded.
- A failed query is saved as a zero-score per-example result, so one transient failure does not discard the rest of an already-paid run. Ingestion failure still stops the run because later queries would not be valid.
- Every query runs in a fresh Hermes session and is instructed to retrieve through `team_memory_search`.

## Dataset provenance

The primary source is the official `hotpot_dev_distractor_v1.json` (7,405 examples, 46,320,117 bytes, SHA-256 `4e9ecb5c8d3b719f624d66b60f8d56bf227f03914f5f0753d6fa1b359d7104ea`). When the CMU host is unavailable, the preparation script uses a commit-pinned, checksum-pinned Hugging Face mirror. It ranks IDs by SHA-256 with seed `hotpot-memory-v1` and selects the first 20. HotpotQA data is licensed under CC BY-SA 4.0.
