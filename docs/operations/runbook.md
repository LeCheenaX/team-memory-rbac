# Operations Runbook

## Startup

Configure `LIBSQL_URL`, `CAS_DIRECTORY`, `QDRANT_URL`, `OBJECT_STORE_URL`, and optional secret values through the deployment environment. Start the service with `npm run dev:server` or the container entry point.

## Upgrade And Rollback

Run CI checks before deployment: typecheck, integration tests, Hermes contract tests, migration validation, and smoke validation. For rollback, stop the new service, restore the previous image and environment, then verify `/live`, `/ready`, and an authenticated read.

## Dependency Failure

If libSQL, CAS storage, Qdrant, or object storage is unavailable, keep the service running for liveness but treat readiness as failed. Retry transient dependency operations with bounded attempts and structured logs carrying trace and audit IDs.

## Data Recovery

Back up CAS objects, libSQL snapshots, and Qdrant collections. Restore libSQL first, then CAS, then Qdrant; rebuild replaceable projections and verify History replay branch heads, CAS content hashes, and vector chunk counts.
