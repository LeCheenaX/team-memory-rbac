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

The current OpenClaw, Hermes, Claude Code, and Codex adapters are tool bridges:
they expose `memory.search`, `memory.write`, sync, and resource tools to an
agent session. A production host lifecycle integration must additionally run
authorized recall before each user instruction and record success or failure
paths after task completion, including enough provenance to recall both the
successful path and failed attempts on a later similar task.

Conversation capture and resource ingestion are separate flows. Conversation
history is captured by the host lifecycle seam after a useful turn, success, or
failure. The host can call the capture interface with stable arguments such as
content/outcome/session details; Team Memory decides whether that produces a new
branch, modifies an existing branch, creates conflict/supersedes relations, or
only stores L1 conversation evidence. Temporary workflow execution state remains
in the agent/model context and must not be persisted as durable memory unless a
later capture summarizes it as a durable fact.

Raw user files and documents are not captured through the conversation capture
tool. The host or agent first imports the file bytes through the Resource/CAS
path. After the CAS object is durable and SQL/History metadata is visible,
resource ingestion may run automatically or through an explicit memory command
to chunk, embed, index, and derive facts/relations from that resource.

Stable agent-facing memory tool results may expose fixed top-level fields, but
any variable entity or entity-branch metadata must be nested under `extra`.
Agents should not invent top-level parameters such as `oldClaim`, `newClaim`,
`intent`, `includeHistory`, `answeredFacts`, or `suppressedFacts`; query/content
should carry the semantic request and the memory system owns merge, conflict,
relation, and retrieval expansion decisions.

`MemoryEntity` is the stable identity for a memory object or a collection of
related atomic facts. It says that the thing exists; the concrete atomic fact
versions live in `MemoryEntityBranch`. Agent-visible catalog tooling should
therefore list entity identities separately from their current branch summaries
and available tags. Follow-up search may narrow by stable filters such as
`entityIds`, `tagsAny`, and `tagsNone`; root identity continues to come from the
trusted session rather than from model-supplied payload fields.

## Resource Ingestion Requirement

Production v1 must expose an explicit incremental ingestion command for
Resource/CAS revisions. Deployments may also run ingestion automatically after a
resource import or revision becomes CAS-first visible, but automatic ingestion
must still use the same authorized resource ingestion pipeline and must not be
implemented as a conversation capture side effect.
