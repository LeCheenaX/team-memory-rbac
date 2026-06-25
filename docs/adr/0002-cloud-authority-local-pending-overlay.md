# Cloud authority with a local pending overlay

Status: accepted

The cloud append-only commit/operation log is the only authority for shared memory, while each client stores only an authorized active snapshot, required indexes, pending operations, sync cursors, and minimal conflict metadata. Local pending operations are immediately queryable and temporarily shadow conflicting snapshot values until the cloud emits an explicit administrator-created resolution commit; the resolution then supersedes the affected local pending operations. Concurrent cloud commits that touch the same conflict key are preserved on conflict branches and are never resolved automatically.
