# Agent Memory Interaction Flows

This document records the expected concrete interaction paths between agents and
Team Memory. It reflects the current design intent, not only the current test
surface.

## Model Boundaries

- `MemoryEntity` is a stable identity for a group of related atomic facts. It
  has a human-readable `name` / `title`, a `description`, tags, status, and an
  embedding. It answers "what things exist in memory" at the summary layer.
- `MemoryEntityBranch` is concrete atomic fact content/details. It has a
  human-readable `name` / `title`, description, tags, extraInfo, embedding,
  importance, confidence, and branch / commit projection state.
- `MemoryRelation` expresses relationships between memory objects, but never
  between relations themselves. Valid endpoints are `memory_entity`,
  `memory_entity_branch`, `resource`, and `resource_chunk`.
- All object ids, including `MemoryEntity.id`, `MemoryEntityBranch.id`,
  `MemoryRelation.id`, `Resource.id`, and `ResourceChunk.id`, are UUID-backed
  unique strings. Ordinary agent-facing catalog/list results do not expose
  `MemoryEntity.id`; they expose human-readable names and tags.
- `extraInfo` describes the object itself. Dependencies, conflicts, citations,
  containment, workflow order, and supersession belong in `MemoryRelation`.
- Agent-supplied identity fields are invalid. Root identity comes from the
  authenticated session.
- Response envelopes may be stable enough for tools to route, but object-specific
  variable metadata must be returned under `extra`.

## Stable Agent Tool Inputs

Search:

```json
{
  "query": "natural-language recall prompt",
  "limit": 10,
  "layer": "L3",
  "names": ["human-readable memory name"],
  "tagsAny": ["tag"]
}
```

`query` is required. `limit`, `layer`, `names`, and `tagsAny` are optional.
`layer` defaults to `L3`.

Catalog:

```json
{}
```

Catalog/list has no required parameters and no Agent-supplied id parameters in
v1. It lists the trusted session root name, visible `MemoryEntity` names, and
visible tags.

Update:

```json
{
  "target": {
    "kind": "memory_entity",
    "name": "human-readable target name"
  },
  "patch": {
    "description": "updated content"
  }
}
```

`target` and `patch` are required. `target.kind` must be one of
`memory_entity`, `memory_entity_branch`, `resource`, or `memory_relation`.
`target.name` is the human-readable target name; if that name is ambiguous, Team
Memory returns an ambiguity result and the Agent should search/catalog first.

`patch` may only contain fields valid for the target kind:

- `MemoryEntity`: `name` / `title`, `description`, `tags`, `status`.
- `MemoryEntityBranch`: `name` / `title`, `description`, `tags`, `status`,
  `extraInfo`.
- `Resource`: text/content edits. Code and Markdown-like resources may be
  updated with `lineRange`; binary files, archives, images, and other
  non-line-addressable attachments require whole-resource replacement.
- `MemoryRelation`: `name` / `title`, `description`, `tags`, `status`,
  `sourceId`, `targetId`, `relationType`.

Optional update mechanics are limited to `lineRange` for line-addressable
Resource edits, `replaceMode: "whole_resource"` for whole Resource replacement,
and an explicit conflict signal when the Agent/user intentionally records a
contradiction.

Agents do not pass `includeHistory`, `oldClaim`, `newClaim`, `intent`,
relationship intent, user identity, subject, task scope, root identity, source
metadata, outcome, session provenance, fact keywords, embeddings, BM25 fields,
timestamps, or generated ids.

## Memory Update, Recall, And Reranking Rules

Memory has two primary paths: retrieval reads and durable updates. Durable
updates are append-oriented. Deletion is exceptional and normally represented by
tombstoning; RBAC controls who can tombstone memory or adjudicate conflicts.

Agent-facing update does not run recall inside the same call. If an Agent needs
context, it calls recall first, receives memory context, and then sends a
separate update. When applying the update, Team Memory may compare the
target/update against existing memory for deduplication. If the best matching
atomic fact is above the deduplication threshold, the write is a duplicate
signal. It must not rewrite or merge fact content. It may only update ranking
metadata such as recency, importance, weight, or timestamps.

If similarity is below the deduplication threshold, the write is new concrete
fact content/details. Without an explicit conflict signal from the agent/user capture,
Team Memory creates a new `MemoryEntityBranch` and may create
`MemoryRelation(relates_to)`. It must not call an LLM merge and must not
directly modify the old branch. Only an explicit conflict signal may create
`MemoryRelation(contradicts)`.

A commit represents one agent or user operation. One tool call may contain
multiple atomic actions, such as creating a branch, creating a relation,
replacing a relation, or changing metadata. Atomic actions that form one logical
memory update should be recorded under one commit.

Agent-updatable resources and fields:

- `MemoryEntity`: `name` / `title`, `description`, `tags`, and `status`.
- `MemoryEntityBranch`: `name` / `title`, `description`, `tags`, `status`, and
  `extraInfo`.
- `Resource`: code and Markdown-like text resources can be updated to specific
  lines and reviewed as diffs; binary files, archives, images, and other
  non-line-addressable attachments can only be replaced as whole resources.
- `MemoryRelation`: `name` / `title`, `description`, `tags`, `status`,
  `sourceId`, `targetId`, and `relationType`.

System-managed resources and fields:

- `id` / uuid, `createdAt`, `updatedAt`, embeddings, BM25 index rows, source
  metadata, session provenance, and host provenance.

Atomic facts require durable embeddings. Production memory configuration must
require an embedding model for `MemoryEntityBranch`, `MemoryEntity`, and
`ResourceChunk` projection. Embeddings belong logically to memory objects but
may be physically stored in the vector database. Returned memory objects may
include their embedding directly when the caller needs it.

Recall is candidate generation followed by reranking. If `tagsAny` is present,
vector search and libSQL lookups must apply the same authorized tag filtering.
Candidate generation uses BM25 search; spaCy entity extraction from `query`,
capped at eight extracted entities, followed by vector search with similarity
`>= 0.5`; and libSQL relation expansion for every object hit by semantic
search. Agents do not pass extracted keyword lists during update; if an agent
wants context, it calls recall first and then sends a separate update.

Layer behavior:

- `L3` returns only `MemoryEntity` results and does not expand relations.
- `L2` returns `MemoryEntity`, `MemoryEntityBranch`, or relation-packed
  `MemoryEntityBranch` candidates.
- `L1` may return raw `Resource` / `ResourceChunk` candidates, but reranking does
  not guarantee that raw resources appear in top K.

Relation packing rules:

| Relation type | Packing rule |
| --- | --- |
| `has` | Do not pack. |
| `depends_on` | Pack `A` and `B` only when `A depends_on B`. |
| `relates_to` | Do not pack. |
| `refers_to` | Pack `A` and `B` only when `A refers_to B`. |
| `contradicts` | Pack `A` and `B`. |
| `supersedes` | Pack `A` and `B` only when `B` supersedes `A`. |
| `next_is` | Walk forward from `A next_is B next_is C`, walk backward from `Z next_is A`, and pack `ZABC`. |

The same hit object `A` may be packed multiple times. Each pack reranks as an
independent candidate.

BM25 raw scores are normalized with
`bm25_normalized = 1 / (1 + exp(-steepness * (raw_score - midpoint)))`.
Parameters adapt to query length: `<= 3` terms uses midpoint `5.0` and
steepness `0.7`; `<= 6` uses `7.0` and `0.6`; `<= 9` uses `9.0` and `0.5`;
`<= 15` uses `10.0` and `0.5`; `> 15` uses `12.0` and `0.5`.

For semantic hits, score equals vector similarity. For related packed entities:

```txt
memory_count_weight = 1.0 / (1.0 + 0.001 * (num_linked_of_certain_relation - 1)^2)
entity_boost = similarity * ENTITY_BOOST_WEIGHT * memory_count_weight
```

`ENTITY_BOOST_WEIGHT` is `0.5` for unpacked relation types such as `has`,
`relates_to`, and source-side supersession; `0.8` for packed `refers_to`; `1.0`
for packed `contradicts` and packed supersession; and `1.5` for packed
`depends_on` and `next_is`.

For each recalled object, fuse repeated signals with
`raw = semantic + bm25 + entity_boost` and `final = min(raw / max_expected,
1.0)`. `max_expected` is `1.0` for semantic only, `2.0` for semantic + BM25,
`2.0` for semantic + entity, and `3.0` for semantic + BM25 + entity. The
semantic + entity and semantic + BM25 + entity divisors deliberately preserve
relation boosts. Return top K after fusion.

## Scenario 1: Provider Availability And Identity

Agent:

1. Ask which long-term memory provider is active.
2. Call provider status, identity, or catalog tooling.
3. Report the current provider mode, current trusted root, available tools, and
   whether the token/session is available.

Real path:

1. Hermes loads `team_memory` plugin.
2. Plugin reads `TEAM_MEMORY_TOKEN` or `TEAM_MEMORY_SESSION_FILE`.
3. Plugin initializes `HermesTeamMemoryProvider.from_local(...)` or
   `.from_http(...)`.
4. Provider calls `memory.catalog` or identity endpoints through the local/http
   client.
5. Gateway authenticates the session and returns trusted identity.

Memory result:

```json
{
  "rootEntityId": "00000000-0000-4000-8000-000000000001",
  "branchRef": "main",
  "entities": [],
  "tags": [],
  "extra": {
    "mode": "local",
    "provider": "team_memory"
  }
}
```

## Scenario 2: Tool Discovery And Capability Listing

Agent:

1. Ask for available memory tools.
2. List tools without invoking administrative or host-internal tools.
3. Distinguish Team Memory tools from Hermes personal memory tools.

Real path:

1. Hermes plugin exposes `team_memory_search`, `team_memory_catalog`, and
   `team_memory_capture`.
2. Gateway/MCP exposes ordinary Agent tools for `memory.search`,
   `memory.catalog` / list, and `memory.capture` / update.
3. Resource import, sync, conflict adjudication, and administrative write tools
   are internal, host-facing, or administrator-facing surfaces according to
   RBAC; they are not part of the ordinary Agent interface.
4. Tool visibility is filtered by the current session and delegation.

Memory result:

```json
{
  "tools": [
    { "name": "team_memory_search", "extra": { "writes": false } },
    { "name": "team_memory_catalog", "extra": { "writes": false } },
    { "name": "team_memory_capture", "extra": { "writes": true } }
  ]
}
```

## Scenario 3: Initial Recall Before Answering

Agent:

1. Receive the user prompt.
2. Call `team_memory_search` / `memory.search` with natural-language `query`
   and optional `limit`.
3. Answer from returned branches, resources, chunks, and relations.

Real path:

1. `team_memory_search` -> `HermesTeamMemoryProvider.search`.
2. Provider calls `memory.search` when filters are supplied, otherwise lifecycle
   recall may call `/host/hermes/recall`.
3. Gateway authenticates token and rejects identity override fields.
4. `PermissionRouter` authorizes `search:memory_entity`.
5. `MemoryRetrievalAdapter` searches BM25, vectors, SQL active view, and relation
   graph.
6. Results are ranked and returned.

Memory result:

```json
{
  "rootEntityId": "00000000-0000-4000-8000-000000000001",
  "branchRef": "main",
  "items": [
    {
      "kind": "entity",
      "entity": { "id": "11111111-1111-4111-8111-111111111111" },
      "branch": {
        "id": "22222222-2222-4222-8222-222222222221",
        "title": "Local Hermes test uses local Team Memory",
        "description": "Hermes runs in a container with local Team Memory and no HTTP server.",
        "tags": ["project:local-hermes-test", "hermes"],
        "extra": {}
      },
      "evidence": [],
      "score": 1,
      "origin": "cloud_active"
    }
  ]
}
```

## Scenario 4: Catalog Then Narrowed Search

Agent:

1. Call `memory.catalog` / `team_memory_catalog`.
2. Inspect visible `MemoryEntity` names and tags.
3. Call search again with `names`, `tagsAny`, or `layer`.

Real path:

1. `team_memory_catalog` -> provider `.catalog()` -> client
   `call_tool("memory.catalog")`.
2. Gateway authenticates and reads active view for the session root.
3. Gateway filters by RBAC task scope.
4. Agent uses returned human-readable names or tags in a second `memory.search`.

Memory result:

```json
{
  "rootName": "test1-local",
  "branchRef": "main",
  "entities": [
    {
      "name": "local hermes test",
      "status": "active",
      "tags": ["project:local-hermes-test", "hermes"]
    }
  ],
  "tags": [
    {
      "tag": "hermes",
      "count": 1,
      "names": ["local hermes test"]
    }
  ]
}
```

## Scenario 5: Related Fact Search And Relation Expansion

Agent:

1. Search for a fact or project.
2. If a high-value result has relations, search or expand around that result.
3. Use related entities, branches, resources, and chunks to answer.

Real path:

1. Initial search returns candidate branches.
2. Retrieval expands `MemoryRelation` edges such as `relates_to`, `refers_to`,
   `has`, and `depends_on`.
3. Related objects are ranked and returned with relation evidence.

Memory result:

```json
{
  "items": [
    {
      "kind": "entity",
      "entity": { "id": "11111111-1111-4111-8111-111111111111" },
      "branch": { "id": "22222222-2222-4222-8222-222222222221" }
    },
    {
      "kind": "relation",
      "relation": {
        "sourceKind": "memory_entity_branch",
        "sourceId": "22222222-2222-4222-8222-222222222221",
        "targetKind": "resource_chunk",
        "targetId": "33333333-3333-4333-8333-333333333333",
        "relationType": "refers_to"
      }
    }
  ]
}
```

## Scenario 6: Workflow Recall And Expansion

Agent:

1. Search for the user's task.
2. If a returned branch represents a workflow, search again by workflow entity id
   or workflow tags.
3. Read related steps through relation expansion.

Real path:

1. Retrieval finds workflow branch candidates through BM25/vector/SQL.
2. Retrieval expands `has`, `depends_on`, and `next_is`.
3. The result includes workflow branch, step branches, required resources, and
   ordering relations.

Memory result:

```json
{
  "items": [
    {
      "kind": "entity",
      "entity": { "id": "workflow:code-b-approval" },
      "branch": {
        "id": "44444444-4444-4444-8444-444444444444",
        "title": "Code B approval workflow",
        "description": "Fetch information, modify Code B, submit approval, then wait for approval.",
        "tags": ["workflow", "project:code-b"],
        "extra": {
          "triggerIntent": ["execute Code B approval workflow"],
          "purpose": "Fetch information, modify code, submit approval, and complete approval."
        }
      }
    },
    {
      "kind": "relation",
      "relation": {
        "sourceId": "44444444-4444-4444-8444-444444444444",
        "sourceKind": "memory_entity_branch",
        "targetId": "55555555-5555-4555-8555-555555555555",
        "targetKind": "memory_entity_branch",
        "relationType": "next_is",
        "ordinal": 1
      }
    }
  ]
}
```

## Scenario 7: Workflow Execution With Validation

Agent:

1. Execute recalled workflow steps in conversation/model context.
2. Verify each step with external tool results.
3. Keep temporary task state in model context only.
4. Capture only durable outcomes after the workflow has useful lasting value.

Real path:

1. Memory returns workflow structure.
2. Agent executes external tools directly.
3. Memory is not called for temporary step state.
4. Lifecycle capture or explicit capture records durable outcome later.

Memory result:

```json
{
  "status": "not_called_for_temporary_state",
  "extra": {
    "reason": "temporary execution state belongs in conversation context"
  }
}
```

## Scenario 8: Additive Durable Capture

Agent:

1. User asks to remember a durable fact or useful outcome.
2. Agent calls update/capture with stable target fields and patch content.
3. Agent does not provide relationship payloads.

Real path:

1. `team_memory_capture` -> provider `.add(...)`, or explicit memory update.
2. Provider calls the trusted local/http memory interface.
3. Gateway authenticates and writes through the memory update path.
4. After the memory system has been called, background processing may extract
   atomic facts and compare them to related memories by vector similarity.
5. If similarity is above the dedupe threshold, memory deduplicates: it does not
   modify the existing branch content, and only updates recency / access weight /
   importance signals.
6. If similarity is below the dedupe threshold and the agent did not explicitly
   mark the content as conflicting, memory treats it as new fact content/details:
   appends a new `MemoryEntityBranch` and may add a `relates_to` relation.
7. Normal capture does not trigger LLM merge and does not directly modify an old
   branch.

Memory result:

```json
{
  "status": "captured",
  "entityId": "66666666-6666-4666-8666-666666666666",
  "branchId": "77777777-7777-4777-8777-777777777777",
  "commitIds": [
    "host-capture-entity-commit:uuid",
    "host-capture-branch-commit:uuid"
  ],
  "extra": {
    "host": "hermes",
    "sessionId": "20260708_040112_127de3",
    "outcome": "success"
  }
}
```

## Scenario 9: User Correction Without Conflict

Agent:

1. User gives a correction or clarification.
2. If context is needed, agent first calls recall.
3. Agent calls update/capture with the corrected durable target and patch.
3. Agent does not invent `oldClaim`, `newClaim`, `intent`, or relation
   arguments.

Real path:

1. Update enters the stable memory update path with trusted session context.
2. Memory applies the target/patch and may compare the update with existing
   memory to enforce dedupe rules.
3. If similarity is above the dedupe threshold, memory treats the content as a
   duplicate mention and only updates recency / access weight / importance
   signals.
4. If similarity is below the dedupe threshold, memory appends a new
   `MemoryEntityBranch` under the relevant entity identity and may add a
   `relates_to` relation to nearby branches.
5. Memory does not run an LLM merge and does not modify old branch content.

Memory result:

```json
{
  "status": "captured",
  "outcome": "success",
  "entityId": "11111111-1111-4111-8111-111111111111",
  "branchId": "22222222-2222-4222-8222-222222222222",
  "commitIds": ["commit:add-local-hermes-related-fact-v2"],
  "extra": {
    "captureDecision": "new_branch",
    "createdRelations": [
      {
        "relationType": "relates_to",
        "sourceId": "22222222-2222-4222-8222-222222222222",
        "targetId": "22222222-2222-4222-8222-222222222221"
      }
    ]
  }
}
```

## Scenario 10: User Correction With Conflict

Agent:

1. User states that an existing remembered fact is wrong or belongs to a
   different thing.
2. If context is needed, agent first calls recall.
3. Agent calls update/capture with stable target and patch content that
   explicitly marks the new memory as conflicting with the remembered fact.
4. Agent can later search by corrected name or tags.

Real path:

1. Update enters the stable memory update path with trusted session context.
2. Memory recognizes the explicit conflict signal from the agent/user wording or
   update mode.
3. In one commit, memory creates a new `MemoryEntityBranch` and a
   `MemoryRelation` with `relationType: "contradicts"` from the new branch to
   the old branch.
4. Without an explicit conflict signal, this path must not create
   `contradicts`; the non-conflict path creates a new branch and may create
   `relates_to`.

Memory result:

```json
{
  "status": "captured",
  "entityId": "88888888-8888-4888-8888-888888888888",
  "branchId": "99999999-9999-4999-8999-999999999999",
  "commitIds": ["commit:test-1-correction"],
  "extra": {
    "createdRelations": [
      {
        "id": "relation:test-1-v2-contradicts-v1",
        "relationType": "contradicts",
        "sourceId": "99999999-9999-4999-8999-999999999999",
        "targetId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      }
    ]
  }
}
```

## Scenario 11: Conflict-Aware Search And Answering

Agent:

1. Search for a topic.
2. Inspect returned branches and relations.
3. Prefer current or superseding branches unless the query asks for history.
4. Mention conflict only when relevant.

Real path:

1. Retrieval finds matching branches.
2. Retrieval reads nearby `contradicts` / `supersedes` relations.
3. Current/superseding branches rank ahead of contradicted or superseded
   branches.
4. If the natural-language query asks for history, older conflicting branches may
   also be returned. No `includeHistory` flag is needed.

Memory result:

```json
{
  "items": [
    {
      "kind": "entity",
      "entity": { "id": "88888888-8888-4888-8888-888888888888" },
      "branch": {
        "id": "99999999-9999-4999-8999-999999999999",
        "title": "Test 1 is about OpenClaw",
        "tags": ["project:test-1", "openclaw"],
        "status": "active",
        "extra": {}
      }
    },
    {
      "kind": "relation",
      "relation": {
        "relationType": "contradicts",
        "sourceId": "99999999-9999-4999-8999-999999999999",
        "targetId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      }
    }
  ]
}
```

## Scenario 12: Raw Resource Import

Agent:

1. User provides a raw file or document.
2. Agent imports the file as a Resource/CAS object.
3. Agent does not paste the whole document into conversation capture.

Real path:

1. Agent calls `memory.importResource` / resource import API.
2. Resource service stores the raw content in CAS.
3. History records the resource revision.
4. If configured, ingestion may be triggered automatically; otherwise the agent
   can call the explicit ingestion command.

Memory result:

```json
{
  "resource": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "sourceType": "document",
    "title": "Design document"
  },
  "revisionId": "revision:design-doc:1",
  "extra": {
    "contentHash": "sha256:..."
  }
}
```

## Scenario 13: Resource Ingestion, Chunking, And Fact Extraction

Agent:

1. After raw resource import or update, do not call chunking or embedding
   manually.
2. Use search to retrieve chunks or extracted facts later.

Real path:

1. Resource create/update writes bytes through the authorized Resource/CAS path.
2. The framework automatically starts ingestion for the durable Resource
   revision.
3. Ingestion chunks or rechunks the resource.
4. Ingestion writes `ResourceChunk` objects, embeddings, and BM25 rows.
5. Background or explicit extraction can create memory entities/branches and
   relations referring to chunks.

Memory result:

```json
{
  "resourceId": "550e8400-e29b-41d4-a716-446655440000",
  "chunks": [
    {
      "id": "6f8d8b63-34bd-4d7f-bf8c-4a0f78b5f63a",
      "resourceId": "550e8400-e29b-41d4-a716-446655440000",
      "extra": {
        "offsetStart": 0,
        "offsetEnd": 1200
      }
    }
  ],
  "rebuiltOnly": false
}
```

## Scenario 14: RBAC, Local/Cloud Scope, And Sync Boundary

Agent:

1. Use only the trusted session token.
2. Do not pass forged `rootEntityId` or subject fields.
3. In local no-sync tests, confirm that no sync or HTTP Team Memory server was
   used.
4. In cloud/sync mode, use explicit sync/status tools only when the test asks for
   them.

Real path:

1. Gateway rejects payload identity override fields before routing.
2. Policy engine checks action/resource permissions.
3. Local mode reads the authorized local working state; cloud mode relies on the
   server authority and sync watermarks.
4. Read-only sessions can search/catalog but cannot capture/write/import.
5. Sync tools expose pull/status only when available and authorized.

Memory result:

```json
{
  "allowed": false,
  "reason": "request payload cannot provide rootEntityId",
  "extra": {
    "mode": "local",
    "syncUsed": false,
    "httpServerUsed": false
  }
}
```
