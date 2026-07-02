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
