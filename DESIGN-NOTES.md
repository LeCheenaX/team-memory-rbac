# Design Notes

## Production v1 Authority Boundary

Production v1 has one logical Cloud Authority. That authority owns the visible
History/SQL state, the authoritative CAS namespace, the authoritative RBAC
state, and the replaceable retrieval projections such as Qdrant, BM25, and the
relation store.

The Team Memory service is a business entry point. A deployment may run one
service worker, or multiple workers, but workers are not authorities. Multiple
workers are valid only when they share the same logical Cloud Authority and the
same authoritative SQL/History, CAS, RBAC, Qdrant/BM25/relation stores. v1
forbids AP multi-master cloud authority behavior where each service accepts
independent authoritative writes and reconciles them later.

## CAS-First Visibility

Any History/SQL commit that references resource bytes must become visible only
after every referenced CAS object is durably readable by content hash from the
same Cloud Authority. The write order is:

1. write the CAS object by `contentHash`;
2. read the CAS object back and verify the hash;
3. commit the SQL/History metadata.

If CAS write or verification fails, History/SQL does not advance. Orphaned CAS
objects without SQL references are allowed and can be garbage-collected later.
Visible SQL metadata pointing at unreadable CAS content is not allowed.

## CAS Deployment Modes

`filesystem` CAS is valid for a single service worker. It is also valid for
multiple workers only when all workers mount the same durable shared volume.
Workers with independent local disks must not use filesystem CAS against the
same Cloud Authority.

`object_store` CAS is the production backend for deployments where multiple
service workers may read the same Cloud Authority state without a shared
filesystem. Objects are addressed by `contentHash` through `OBJECT_STORE_URL`.

## v2 Target

v2 keeps one logical Cloud Authority, but may implement it with CP distributed
systems: distributed SQL for History/RBAC, distributed object storage for CAS,
and clustered retrieval projections. v2 is not an AP multi-master design with
independent cloud authority replicas.

## Conflict Visibility Requirements

Production v1 keeps unresolved cloud conflict branches out of the local
authorized working replica. If a local pending atomic operation caused the
conflict, the local pending overlay remains the local visible state until a
resolution commit arrives. If another client produced an unresolved cloud
conflict for a file or memory object that this client has not locally modified,
v1 keeps the local replica unchanged rather than syncing the conflict branch.

After a conflict is resolved, agents do not require a built-in background sync
loop for v1. They need an exposed CLI or tool call that can pull the resolution
commit and reconcile the local replica on demand.

Raw Resource edits use the same v1 local-pending rule. A client can stage a
pending resource revision in its local authorized working replica and keep that
revision visible locally while the cloud stores an unresolved resource conflict.
Pushing the revision to the cloud must still use the CAS-first resource write
path; local pending state is not allowed to create visible SQL/History metadata
without durable CAS bytes.

Production v2 must add a ranked unresolved-conflict preview for clients that do
not already have a local pending operation on the conflicted object. The cloud
should score competing atomic operations and return the highest-scoring
candidate as a preview while preserving the unresolved conflict branch and the
eventual resolution-commit semantics.

## Agent Memory Lifecycle Requirement

The current OpenClaw, Hermes, Claude Code, and Codex adapters are tool bridges.
The ordinary agent-facing surface is intentionally small: catalog/list visible
tags and root `MemoryEntity` names, search/recall memory, and capture/update
durable memory. Low-level resource import, sync, conflict adjudication, and
administrative write tools are internal, host-facing, or administrator-facing
surfaces governed by RBAC; they are not the ordinary Agent interface. A
production host lifecycle integration must additionally run authorized recall
before each user instruction and record success or failure paths after task
completion, including enough provenance to recall both the successful path and
failed attempts on a later similar task.

Conversation capture and resource ingestion are separate flows. Conversation
history is captured by the host lifecycle seam after a useful turn, success, or
failure. Host lifecycle adapters can attach outcome and session provenance
because they sit at the trusted host seam. The agent-facing memory update
interface does not accept outcome or source/session fields; those are matched
from the authenticated session and host context. Team Memory decides whether
captured content produces a new branch, modifies an existing branch, creates
conflict/supersedes relations, or only stores L1 conversation evidence.
Temporary workflow execution state remains in the agent/model context and must
not be persisted as durable memory unless a later capture summarizes it as a
durable fact.

Raw user files and documents are not captured through the conversation capture
tool. The host or authorized resource path first imports the file bytes through
the Resource/CAS path. After a Resource is created or updated and the CAS object
is durable with SQL/History metadata visible, the framework automatically
rechunks the Resource, recalculates embeddings, refreshes BM25 rows, and updates
`ResourceChunk` projections. Explicit ingestion commands may exist for
administrator backfill or retry, but ordinary Agent update does not need to
request chunking or embedding.

Stable agent-facing memory tool results may expose fixed top-level fields, but
any variable entity or entity-branch metadata must be nested under `extra`.
Agents should not invent top-level parameters such as `oldClaim`, `newClaim`,
`intent`, `includeHistory`, `answeredFacts`, `suppressedFacts`, `source`,
`session`, embeddings, BM25 fields, timestamps, or generated ids. The memory
system owns source provenance, merge, conflict, relation, indexing, and
retrieval expansion decisions.

`MemoryEntity` is the stable identity for a memory object or a collection of
related atomic facts. It has a human-readable `name` / `title`, `description`,
tags, status, and an embedding. It is the summary/collection layer at L3; the
concrete content/details live in `MemoryEntityBranch` at L2. A
`MemoryEntityBranch` also has a human-readable `name` / `title`, description,
tags, status, optional `extraInfo`, and an embedding. Agent-visible catalog/list
tooling should expose visible `MemoryEntity` names and tags, not internal ids or
branch ids. Follow-up search may narrow by stable human-readable `names` and
`tagsAny`; root identity continues to come from the trusted session rather than
from model-supplied payload fields.

Agent-facing recall has one required parameter, `query`. Optional parameters are
`limit`, `layer`, `names`, and `tagsAny`. `layer` defaults to `L3`.

Agent-facing catalog/list has no required parameters and no Agent-supplied id
parameters in v1. It lists the trusted session root name, visible
`MemoryEntity` names, and visible tags.

Layer behavior:

- `L3` returns only `MemoryEntity` results and does not expand relations.
- `L2` returns `MemoryEntity`, `MemoryEntityBranch`, or relation-packed
  `MemoryEntityBranch` candidates.
- `L1` may return raw `Resource` / `ResourceChunk` candidates, but reranking does
  not guarantee that raw resources appear in top K.

Agent-updatable resources and fields:

- `MemoryEntity`: `name` / `title`, `description`, `tags`, and `status`.
- `MemoryEntityBranch`: `name` / `title`, `description`, `tags`, `status`, and
  `extraInfo`.
- `Resource`: code and Markdown-like text resources can be updated to specific
  lines and reviewed as diffs; binary files, archives, images, and other
  non-line-addressable attachments can only be replaced as whole resources.
- `MemoryRelation`: `name` / `title`, `description`, `tags`, `status`,
  `sourceId`, `targetId`, and `relationType`.

System-managed fields include `id` / uuid, `createdAt`, `updatedAt`,
embeddings, BM25 index rows, source metadata, session provenance, and host
provenance. All object ids, including `MemoryEntity.id`,
`MemoryEntityBranch.id`, `MemoryRelation.id`, `Resource.id`, and
`ResourceChunk.id`, are UUID-backed unique strings. Agent-facing catalog/list
does not return `MemoryEntity.id`; it returns human-readable `MemoryEntity`
names and visible tags so the Agent can use those names as optional search
filters.

Agent-facing capture/update has two required top-level parameters: `target` and
`patch`.

`target` must include:

- `kind`: one of `memory_entity`, `memory_entity_branch`, `resource`, or
  `memory_relation`.
- `name`: the human-readable target name. When the name is ambiguous, the memory
  system must return an ambiguity result or require a prior search/catalog step;
  the ordinary Agent is not expected to know internal ids.

`patch` may include only the fields that are valid for the target kind:

- `MemoryEntity`: `name` / `title`, `description`, `tags`, `status`.
- `MemoryEntityBranch`: `name` / `title`, `description`, `tags`, `status`,
  `extraInfo`.
- `Resource`: text/content edits. Line-addressable resources such as code and
  Markdown may include `lineRange`; non-line-addressable attachments such as
  binary files, archives, and images must use whole-resource replacement.
- `MemoryRelation`: `name` / `title`, `description`, `tags`, `status`,
  `sourceId`, `targetId`, `relationType`.

Optional capture/update parameters are limited to update mechanics that the
Agent can actually supply: `lineRange` for line-addressable Resource edits,
`replaceMode: "whole_resource"` for whole Resource replacement, and an explicit
conflict signal when the user/Agent is intentionally recording a contradiction.
`outcome`, `sources`, `session`, fact keywords, embeddings, BM25 data, ids, and
timestamps are not Agent inputs.

## Memory Update Requirement

Memory has two primary paths: retrieval reads and durable updates. Durable
updates are append-oriented. Deletion is exceptional and normally represented by
tombstoning the memory object; RBAC controls who can tombstone objects or
adjudicate conflicts. Ordinary agents must not directly decide destructive
memory administration.

Memory update does not do implicit recall inside the same agent-facing update
call. If an agent needs context, it calls recall first, receives the relevant
memory context, and then sends a separate update. When applying the update, Team
Memory may compare the target/update against existing memory to enforce
deduplication and conflict rules. If the best matching existing atomic fact is
above the deduplication threshold, the system treats the update as a duplicate
signal. It must not rewrite or merge the fact content. It may only adjust
recency, importance, or other ranking metadata, because repeated and recent
statements make the memory more important.

If the related-memory similarity is below the deduplication threshold, the
update is new concrete fact content/details. When the agent did not explicitly
mark the content as conflicting, Team Memory creates a new `MemoryEntityBranch` and may
create a `MemoryRelation` with `relationType: "relates_to"`. It must not invoke
an LLM merge and must not directly rewrite the old branch.

Only an explicit conflict signal from the agent/user capture path may create a
`MemoryRelation` with `relationType: "contradicts"`. Textual similarity or a
different object value is not enough by itself to create `contradicts`.

A commit represents one agent or user operation. One tool call may contain
multiple atomic actions, such as creating a branch, creating a relation,
replacing a relation, or changing metadata. Those atomic actions should be
recorded under one commit when they are one logical memory update.

Atomic facts must have durable embeddings. Production memory configuration must
require an embedding model for `MemoryEntityBranch`, `MemoryEntity`, and
`ResourceChunk` projection. Embeddings belong logically to memory objects but
may be physically stored in the vector database. Returned memory objects may
include their embedding directly when the caller needs it. A deployment without
a configured embedding provider is not a valid production memory deployment.

## Recall Requirement

Memory recall is a candidate generation phase followed by reranking. If the
query includes `tagsAny`, both vector search and libSQL lookups must apply the
same authorized tag filtering before candidates are returned.

Recall uses three candidate sources:

1. BM25 search.
2. Entity-keyword semantic search. The query is analyzed with spaCy entity
   extraction. At most eight extracted entities are used. For each extracted
   entity, Team Memory performs vector similarity search and recalls matches
   whose similarity is at least `0.5`.
3. Relation expansion. For every object hit by semantic search, Team Memory
   loads all `MemoryRelation` rows for that object from libSQL as a relation
   candidate set. This set can be large; packing and reranking decide what is
   useful.

Relation packing rules:

| Relation type | Packing rule |
| --- | --- |
| `has` | Do not pack. |
| `depends_on` | Pack `A` and `B` only when `A depends_on B`. |
| `relates_to` | Do not pack. |
| `refers_to` | Pack `A` and `B` only when `A refers_to B`. |
| `contradicts` | Pack `A` and `B`. |
| `supersedes` | Pack `A` and `B` only when `B` supersedes `A`. |
| `next_is` | Treat as an iterator: walk forward from `A next_is B next_is C`, walk backward from `Z next_is A`, and pack the whole chain `ZABC`. |

The same hit object `A` may participate in multiple independent packs. Each
pack is a separate reranking candidate.

## Reranking Requirement

BM25 raw scores are normalized with logistic sigmoid:

```txt
bm25_normalized = 1 / (1 + exp(-steepness * (raw_score - midpoint)))
```

`midpoint` and `steepness` adapt to query length:

| Query terms | midpoint | steepness |
| --- | ---: | ---: |
| `<= 3` | `5.0` | `0.7` |
| `<= 6` | `7.0` | `0.6` |
| `<= 9` | `9.0` | `0.5` |
| `<= 15` | `10.0` | `0.5` |
| `> 15` | `12.0` | `0.5` |

For a semantically hit entity, the semantic score is the vector similarity.

For related entities included through relation packing:

```txt
memory_count_weight = 1.0 / (1.0 + 0.001 * (num_linked_of_certain_relation - 1)^2)
entity_boost = similarity * ENTITY_BOOST_WEIGHT * memory_count_weight
```

`ENTITY_BOOST_WEIGHT` values:

| Relation class | Weight |
| --- | ---: |
| Unpacked relation types such as `has`, `relates_to`, and source-side supersession | `0.5` |
| Packed `refers_to` | `0.8` |
| Packed `contradicts` and packed supersession | `1.0` |
| Packed `depends_on` and packed `next_is` | `1.5` |

Scores fuse per recalled object by summing repeated signals:

```txt
raw = semantic + bm25 + entity_boost
final = min(raw / max_expected, 1.0)
```

`max_expected` depends on active signals:

| Active signals | max_expected |
| --- | ---: |
| semantic only | `1.0` |
| semantic + BM25 | `2.0` |
| semantic + entity | `2.0` |
| semantic + BM25 + entity | `3.0` |

The `semantic + entity` and `semantic + BM25 + entity` divisors are deliberately
lower than their theoretical maxima so relation boosts remain visible. After
fusion, recall returns top K candidates.

## Resource Ingestion Requirement

Every accepted Resource create/update/revision must trigger the authorized
Resource ingestion pipeline automatically: rechunk the current Resource content,
recompute `ResourceChunk` and Resource embeddings, refresh BM25 rows, and update
resource evidence projections. Production v1 may also expose an explicit
incremental ingestion command for administrator backfill, repair, or retry, but
ordinary Agent capture/update does not pass chunking or embedding instructions.
Automatic ingestion must not be implemented as a conversation capture side
effect.
