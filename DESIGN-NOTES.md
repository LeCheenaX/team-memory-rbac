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

## Resource Ingestion Requirement

Production v1 does not automatically run ingestion after every resource import
or revision. Instead, HTTP, MCP/agent tools, and CLI must expose an explicit
incremental ingestion command so an agent can chunk and index a chosen resource
revision when the host workflow decides the raw resource is ready.
