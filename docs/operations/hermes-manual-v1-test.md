# Hermes Manual V1 Test Flow

This guide is a from-zero manual acceptance flow for checking the v1 core
behavior with Hermes-style clients on one physical machine. It uses one local
Team Memory server and two Hermes client sessions that talk to the same shared
Cloud Authority.

The flow has two layers:

- a single-Hermes local layer, which exercises the Hermes adapter shape against
  an in-process Team Memory gateway without an HTTP server or sync;
- a multi-Hermes server layer, which exercises one shared service, cross-client
  recall, synchronization events, and conflict resolution.

The full flow checks:

- trusted session identity, with no model-supplied `userId` or `rootEntityId`;
- RBAC isolation between read/write and read-only Hermes clients;
- memory capture, recall, resource import, ingestion, and search;
- cross-client memory visibility through one shared server;
- cloud conflict creation and administrator resolution.

## Scope

This is a manual production-shape smoke test, not a benchmark. It uses the
Hermes Python adapter in this repo to emulate the same provider/tool calls that
a Hermes memory provider should make.

For running the real Hermes Agent in containers, see
`docs/operations/hermes-container.md`.

For one-machine testing, run Qdrant in a container and run the Team Memory
server as a local Node process. Use filesystem CAS and a local libSQL file so
the test does not depend on MinIO or remote services.

The first root administrator is created by an explicit one-time bootstrap
command. Do not use `npm run dev:init` for this manual production-shape test:
`dev:init` intentionally has development defaults, while this guide requires
the operator to choose every identity value explicitly.

## Prerequisites

- Node.js 22.13 or newer
- Python 3.11 or newer
- Docker Desktop or another Docker runtime
- A fresh clone of this repository

Run all commands from the repository root.

The examples use Windows PowerShell. If your machine does not have the Python
launcher command `py`, replace `py -` with `python -`.

## 0. Get The Repository

```powershell
git clone <repository-url> team-memory-rbac
cd team-memory-rbac
```

## 1. Install And Check The Repo

```powershell
npm.cmd install
npm.cmd run check
```

Expected result:

- TypeScript typecheck passes.
- Node tests pass.
- Hermes contract tests pass.

If `npm run ...` is blocked by PowerShell execution policy, use `npm.cmd run ...`
as shown above.

## 2. Start Qdrant

```powershell
docker compose up -d qdrant
```

Check Qdrant:

```powershell
curl.exe http://127.0.0.1:6333/healthz
```

Expected result: Qdrant returns an OK health response.

## 3. Create A Clean Local Runtime And Bootstrap The First Admin

Use a dedicated manual-test data directory.

```powershell
New-Item -ItemType Directory -Force .data\manual | Out-Null

$env:LIBSQL_URL = "file:./.data/manual/team-memory.db"
$env:CAS_BACKEND = "filesystem"
$env:CAS_DIRECTORY = "./.data/manual/cas"
$env:QDRANT_URL = "http://127.0.0.1:6333"
$env:PORT = "3000"
$env:BOOTSTRAP_ROOT_ENTITY_ID = "root:manual-v1"
$env:BOOTSTRAP_USER_ID = "user:manual-admin"
$env:BOOTSTRAP_USER_NAME = "Manual Admin"
$env:BOOTSTRAP_SESSION_ID = "session:manual-admin"
$env:BOOTSTRAP_SESSION_EXPIRES_AT = "2030-01-01T00:00:00.000Z"
```

Initialize the root, administrator assignment, and administrator session:

```powershell
npm.cmd run bootstrap:root-admin
```

Expected result:

```json
{
  "rootEntityId": "root:manual-v1",
  "userId": "user:manual-admin",
  "sessionToken": "..."
}
```

Save the returned token:

```powershell
$env:ADMIN_TOKEN = "<paste sessionToken here>"
```

## 4. Run Local Host Memory Smoke Without A Server

This layer checks local behavior before any shared HTTP service is started. It
uses Hermes, OpenClaw, and Claude Code host adapters against an in-process Team
Memory gateway, so there is no HTTP server and no sync protocol involved. It
still uses the same local libSQL file, filesystem CAS, Qdrant-backed memory
projection, and RBAC policy engine.

This is the server-down expectation: memory read/write/recall works locally;
only cloud synchronization is out of scope while the server is unavailable.

```powershell
$env:LOCAL_HERMES_AGENT_ID = "agent:local-hermes"
$env:LOCAL_HERMES_DELEGATION_ID = "delegation:local-hermes"
$env:LOCAL_HERMES_SESSION_ID = "session:local-hermes"
$env:LOCAL_OPENCLAW_AGENT_ID = "agent:local-openclaw"
$env:LOCAL_OPENCLAW_DELEGATION_ID = "delegation:local-openclaw"
$env:LOCAL_OPENCLAW_SESSION_ID = "session:local-openclaw"
$env:LOCAL_CLAUDE_CODE_AGENT_ID = "agent:local-claude-code"
$env:LOCAL_CLAUDE_CODE_DELEGATION_ID = "delegation:local-claude-code"
$env:LOCAL_CLAUDE_CODE_SESSION_ID = "session:local-claude-code"
$env:LOCAL_HOST_SESSION_EXPIRES_AT = "2030-01-01T00:00:00.000Z"

npm.cmd run local-host-smoke
```

Expected result:

- `mode` is `local_hosts_no_http_no_sync`.
- Results include `hermes`, `openclaw`, and `claude_code`.
- Each host principal is bound to `root:manual-v1`.
- Each host can see `memory.write` and `memory.search`.
- Each host writes and recalls a local smoke memory.
- Each host rejects a forged `rootEntityId`.
- `openclawPlugin.tools` exposes OpenClaw replacement-memory tool names such as
  `memory_search` and `memory_write`.
- `claudeCodeHooks.hookSpecificOutput.additionalContext` contains recalled Team
  Memory context.

If you only want the older single-Hermes local check, run
`npm.cmd run hermes:local-smoke` with the `LOCAL_HERMES_*` variables.

## 5. Start The Team Memory Server

Open a second terminal in the repo root and set the same runtime environment:

```powershell
$env:LIBSQL_URL = "file:./.data/manual/team-memory.db"
$env:CAS_BACKEND = "filesystem"
$env:CAS_DIRECTORY = "./.data/manual/cas"
$env:QDRANT_URL = "http://127.0.0.1:6333"
$env:PORT = "3000"
npm.cmd run dev:server
```

Leave this terminal running.

In the first terminal, check the server:

```powershell
curl.exe http://127.0.0.1:3000/live
curl.exe http://127.0.0.1:3000/ready
curl.exe -H "Authorization: Bearer $env:ADMIN_TOKEN" http://127.0.0.1:3000/identity
```

Expected result:

- `/live` returns `{"status":"ok"}`.
- `/ready` returns `{"status":"ready"}`.
- `/identity` returns the admin session bound to `root:manual-v1`.

## 6. Onboard Three Hermes Sessions

Create two writer Hermes clients and one read-only Hermes client. The writer
clients simulate two separate Hermes installations talking to the same server.

```powershell
@'
import json
import os
from urllib import request

BASE = "http://127.0.0.1:3000"
ADMIN_TOKEN = os.environ["ADMIN_TOKEN"]

def post(path, payload, token=ADMIN_TOKEN):
    req = request.Request(
        BASE + path,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "authorization": f"Bearer {token}",
            "content-type": "application/json",
        },
    )
    with request.urlopen(req, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))["value"]

writer_permissions = [
    {"action": "read", "resourceKind": "memory_entity"},
    {"action": "search", "resourceKind": "memory_entity"},
    {"action": "read", "resourceKind": "resource"},
    {"action": "search", "resourceKind": "resource"},
    {"action": "read", "resourceKind": "resource_chunk"},
    {"action": "search", "resourceKind": "resource_chunk"},
    {"action": "write_entity", "resourceKind": "memory_entity"},
    {"action": "write_entity_branch", "resourceKind": "memory_entity_branch"},
    {"action": "import_resource", "resourceKind": "resource"},
    {"action": "index_resource", "resourceKind": "resource"},
]

read_only_permissions = [
    {"action": "read", "resourceKind": "memory_entity"},
    {"action": "search", "resourceKind": "memory_entity"},
    {"action": "read", "resourceKind": "resource"},
    {"action": "search", "resourceKind": "resource"},
    {"action": "read", "resourceKind": "resource_chunk"},
    {"action": "search", "resourceKind": "resource_chunk"},
]

sessions = {}
for name, permissions in [
    ("hermes-a", writer_permissions),
    ("hermes-b", writer_permissions),
    ("hermes-readonly", read_only_permissions),
]:
    result = post("/admin/agents/onboard", {
        "agentId": f"agent:{name}",
        "delegationId": f"delegation:{name}",
        "sessionId": f"session:{name}",
        "sessionExpiresAt": "2030-01-01T00:00:00.000Z",
        "displayName": name,
        "permissions": permissions,
    })
    sessions[name] = result["session"]["token"]

print(json.dumps(sessions, indent=2))
'@ | py -
```

Save the three returned tokens:

```powershell
$env:HERMES_A_TOKEN = "<paste hermes-a token>"
$env:HERMES_B_TOKEN = "<paste hermes-b token>"
$env:HERMES_READONLY_TOKEN = "<paste hermes-readonly token>"
```

## 7. Verify Hermes Identity And Tool Visibility

```powershell
@'
import os
from src.adapters.hermes.http_client import TeamMemoryHttpClient

BASE = "http://127.0.0.1:3000"

for name, token in [
    ("hermes-a", os.environ["HERMES_A_TOKEN"]),
    ("hermes-b", os.environ["HERMES_B_TOKEN"]),
    ("hermes-readonly", os.environ["HERMES_READONLY_TOKEN"]),
]:
    client = TeamMemoryHttpClient(BASE, token)
    print(name, client.identity())
    print(name, [tool["name"] for tool in client.list_tools()])
'@ | py -
```

Expected result:

- All three sessions resolve to `root:manual-v1`.
- `hermes-a` and `hermes-b` can see write/import/ingest tools.
- `hermes-readonly` cannot see `memory.write`, `memory.importResource`, or
  `memory.ingestResource`.

This checks that tool visibility follows server-side RBAC and is not controlled
by prompt text or client-supplied identity fields.

## 8. Check Permission Isolation

Try to write with the read-only Hermes session:

```powershell
@'
import os
from src.adapters.hermes.http_client import TeamMemoryHttpClient, TeamMemoryHttpError

client = TeamMemoryHttpClient("http://127.0.0.1:3000", os.environ["HERMES_READONLY_TOKEN"])

try:
    client.call_tool("memory.write", {
        "clientMutationId": "manual-readonly-denied",
        "action": "write_entity",
        "resourceKind": "memory_entity",
        "commit": {"id": "commit:manual-readonly-denied"},
        "operation": {
            "kind": "create_entity",
            "id": "operation:manual-readonly-denied",
            "entity": {
                "id": "entity:manual-readonly-denied",
                "rootEntityId": "root:manual-v1",
                "status": "active",
                "createdAt": "2026-07-03T00:00:00.000Z",
                "updatedAt": "2026-07-03T00:00:00.000Z",
            },
        },
    })
except TeamMemoryHttpError as error:
    print(error.status, error.code)
    print(error.decision)
'@ | py -
```

Expected result:

- HTTP status is `403`.
- Error code is `permission_denied`.
- The decision explains the missing write permission.

Now try a forged identity field with a valid writer token:

```powershell
@'
import os
from src.adapters.hermes.http_client import TeamMemoryHttpClient, TeamMemoryHttpError

client = TeamMemoryHttpClient("http://127.0.0.1:3000", os.environ["HERMES_A_TOKEN"])

try:
    client.call_tool("memory.search", {
        "rootEntityId": "root:forged",
        "query": {"kind": "entity", "text": "anything"},
    })
except TeamMemoryHttpError as error:
    print(error.status, error.code, str(error))
'@ | py -
```

Expected result:

- HTTP status is `400`.
- Error code is `validation_failed`.
- The server rejects client-supplied identity fields.

## 9. Capture A Successful Hermes Path

This uses the Hermes memory-provider shape: `add(...)` calls the Team Memory
host lifecycle capture endpoint.

```powershell
@'
import json
import os
from src.adapters.hermes.http_client import HermesTeamMemoryProvider

provider = HermesTeamMemoryProvider.from_http(
    "http://127.0.0.1:3000",
    os.environ["HERMES_A_TOKEN"],
)

result = provider.add(
    [
        {"role": "user", "content": "How do I run the Team Memory manual smoke test?"},
        {
            "role": "assistant",
            "content": (
                "Successful path: start Qdrant, initialize the local runtime, "
                "start Team Memory server, onboard Hermes sessions, then run recall and capture checks."
            ),
        },
    ],
    user_id="hermes-a",
    outcome="success",
)

print(json.dumps(result, indent=2))
'@ | py -
```

Expected result:

- `status` is `captured`.
- The response contains `entityId`, `branchId`, and two commit IDs.

## 10. Recall The Successful Path From Another Hermes Client

```powershell
@'
import json
import os
from src.adapters.hermes.http_client import HermesTeamMemoryProvider

provider = HermesTeamMemoryProvider.from_http(
    "http://127.0.0.1:3000",
    os.environ["HERMES_B_TOKEN"],
)

context = provider.recall_context(
    "I need to run the Team Memory manual smoke test from scratch.",
    session_id="hermes-b",
    limit=8,
)

print(json.dumps(context, indent=2))
'@ | py -
```

Expected result:

- Output tag is `memory-context`.
- `content` contains the successful path captured by Hermes A.
- `memoryIds` is not empty.
- `provenance` includes scored memory sources.

This checks cross-client shared memory: Hermes B recalls memory written by
Hermes A through the same server.

## 11. Capture A Failed Hermes Path And Co-Recall Both Outcomes

Capture a failed attempt:

```powershell
@'
import json
import os
from src.adapters.hermes.http_client import HermesTeamMemoryProvider

provider = HermesTeamMemoryProvider.from_http(
    "http://127.0.0.1:3000",
    os.environ["HERMES_A_TOKEN"],
)

result = provider.add(
    "Failed path: starting Team Memory before Qdrant is ready makes /ready fail and recall cannot use vector-backed retrieval.",
    user_id="hermes-a",
    outcome="failure",
    user_prompt="Run the Team Memory manual smoke test",
    error_summary="Qdrant was not started before the server readiness check.",
)

print(json.dumps(result, indent=2))
'@ | py -
```

Recall again:

```powershell
@'
import json
import os
from src.adapters.hermes.http_client import HermesTeamMemoryProvider

provider = HermesTeamMemoryProvider.from_http(
    "http://127.0.0.1:3000",
    os.environ["HERMES_B_TOKEN"],
)

context = provider.recall_context(
    "Run the Team Memory manual smoke test; include common failure modes.",
    session_id="hermes-b",
    limit=10,
)

print(json.dumps(context, indent=2))
'@ | py -
```

Expected result:

- The recalled memory includes the success path.
- The recalled memory also includes the failure path about Qdrant readiness.

This checks the design goal that later similar tasks can retrieve both a
successful path and a failed path.

## 12. Import, Ingest, And Search A Raw Resource

Use Hermes A to import a raw document, then explicitly ingest it.

```powershell
@'
import json
import os
from src.adapters.hermes.http_client import TeamMemoryHttpClient

client = TeamMemoryHttpClient("http://127.0.0.1:3000", os.environ["HERMES_A_TOKEN"])

imported = client.call_tool("memory.importResource", {
    "clientMutationId": "manual-resource-import",
    "resourceId": "resource:manual-runbook",
    "title": "Manual Hermes Runbook",
    "sourceType": "document",
    "content": (
        "Manual Hermes runbook evidence. "
        "The critical order is Qdrant first, dev init second, server third, Hermes clients fourth."
    ),
})
print("imported", json.dumps(imported, indent=2))

ingested = client.call_tool("memory.ingestResource", {
    "clientMutationId": "manual-resource-ingest",
    "resourceId": "resource:manual-runbook",
    "maxChunkCharacters": 240,
})
print("ingested", json.dumps(ingested, indent=2))
'@ | py -
```

Search from Hermes B:

```powershell
@'
import json
import os
from src.adapters.hermes.http_client import TeamMemoryHttpClient

client = TeamMemoryHttpClient("http://127.0.0.1:3000", os.environ["HERMES_B_TOKEN"])

result = client.call_tool("memory.search", {
    "resourceKind": "resource_chunk",
    "query": {
        "kind": "keyword",
        "text": "critical order Qdrant dev init server Hermes",
        "limit": 5,
    },
})

print(json.dumps(result, indent=2))
'@ | py -
```

Expected result:

- Ingestion creates at least one chunk.
- Hermes B finds the chunk by keyword search.
- Returned evidence traces back to the imported resource/chunk.

## 13. Verify History And Shared Sync State

```powershell
@'
import json
import os
from src.adapters.hermes.http_client import TeamMemoryHttpClient

client = TeamMemoryHttpClient("http://127.0.0.1:3000", os.environ["HERMES_A_TOKEN"])

history = client.call_tool("memory.history", {})
sync = client.call_tool("memory.syncPull", {"knownCommitWatermark": 0})

print("history")
print(json.dumps(history, indent=2))
print("sync")
print(json.dumps(sync, indent=2))
'@ | py -
```

Expected result:

- History includes bootstrap, lifecycle capture, resource import, and ingestion
  commits.
- Sync returns authorized events for the same root and does not expose any
  unrelated root.

In the direct Hermes HTTP-provider shape, both clients synchronize through the
shared server. A client-side local authorized working replica can additionally
consume the same `/sync/pull` events, but Hermes itself should not become a
second authority.

## 14. Create A Cross-Client Conflict

This step proves v1 cloud conflict behavior. Hermes A and Hermes B both start
from the same base head. A writes one branch candidate. B then writes a
different branch candidate for the same logical entity using the stale base
head. The cloud must keep B's write on a conflict branch and leave the active
target branch unchanged until an administrator resolves the conflict.

```powershell
@'
import json
import os
from src.adapters.hermes.http_client import TeamMemoryHttpClient, TeamMemoryHttpError

BASE = "http://127.0.0.1:3000"
NOW = "2026-07-03T00:00:00.000Z"

a = TeamMemoryHttpClient(BASE, os.environ["HERMES_A_TOKEN"])
b = TeamMemoryHttpClient(BASE, os.environ["HERMES_B_TOKEN"])

entity = a.call_tool("memory.write", {
    "clientMutationId": "manual-conflict-create-entity",
    "action": "write_entity",
    "resourceKind": "memory_entity",
    "commit": {"id": "commit:manual-conflict-create-entity"},
    "operation": {
        "kind": "create_entity",
        "id": "operation:manual-conflict-create-entity",
        "entity": {
            "id": "entity:manual-conflict",
            "rootEntityId": "root:manual-v1",
            "currentBranchId": "branch:manual-conflict-a",
            "status": "active",
            "createdAt": NOW,
            "updatedAt": NOW,
        },
    },
})

base_head = entity["write"]["commit"]["id"]
print("base head", base_head)

a_result = a.call_tool("memory.write", {
    "clientMutationId": "manual-conflict-a",
    "expectedHeadCommitId": base_head,
    "action": "write_entity_branch",
    "resourceKind": "memory_entity_branch",
    "commit": {"id": "commit:manual-conflict-a"},
    "operation": {
        "kind": "create_entity_branch",
        "id": "operation:manual-conflict-a",
        "branch": {
            "id": "branch:manual-conflict-a",
            "entityId": "entity:manual-conflict",
            "rootEntityId": "root:manual-v1",
            "branchRef": "main",
            "title": "Conflict candidate A",
            "description": "Hermes A says keep the original manual procedure.",
            "tags": ["manual-conflict"],
            "importance": 1,
            "confidence": 0.8,
            "status": "active",
            "createdAt": NOW,
            "updatedAt": NOW,
        },
    },
})
print("A accepted", json.dumps(a_result, indent=2))

try:
    b.call_tool("memory.write", {
        "clientMutationId": "manual-conflict-b",
        "expectedHeadCommitId": base_head,
        "action": "write_entity_branch",
        "resourceKind": "memory_entity_branch",
        "commit": {"id": "commit:manual-conflict-b"},
        "operation": {
            "kind": "create_entity_branch",
            "id": "operation:manual-conflict-b",
            "branch": {
                "id": "branch:manual-conflict-b",
                "entityId": "entity:manual-conflict",
                "rootEntityId": "root:manual-v1",
                "branchRef": "main",
                "title": "Conflict candidate B",
                "description": "Hermes B says use the alternate conflict procedure.",
                "tags": ["manual-conflict"],
                "importance": 1,
                "confidence": 0.8,
                "status": "active",
                "createdAt": NOW,
                "updatedAt": NOW,
            },
        },
    })
except TeamMemoryHttpError as error:
    print("B conflict", error.status, error.code, str(error))

conflicts = a.call_tool("memory.conflicts", {})
print(json.dumps(conflicts, indent=2))
'@ | py -
```

Expected result:

- A's write is accepted.
- B's write returns HTTP `409` with code `conflict`.
- `memory.conflicts` shows one unresolved conflict.
- Searching for `manual-conflict` still returns candidate A, not candidate B,
  because unresolved cloud conflict branches do not change the active target
  branch.

## 15. Resolve The Conflict

First list the conflict ID:

```powershell
@'
import json
import os
from src.adapters.hermes.http_client import TeamMemoryHttpClient

client = TeamMemoryHttpClient("http://127.0.0.1:3000", os.environ["HERMES_A_TOKEN"])
conflicts = client.call_tool("memory.conflicts", {})
print(json.dumps(conflicts, indent=2))
print("CONFLICT_ID=" + conflicts["conflicts"][0]["id"])
'@ | py -
```

Save the conflict ID:

```powershell
$env:CONFLICT_ID = "<paste conflict id here>"
```

Resolve with the administrator token. Use `keep_target` to keep Hermes A's
accepted target branch, or `take_incoming` to promote Hermes B's conflicted
incoming branch. This example uses `take_incoming`.

```powershell
@'
import json
import os
from src.adapters.hermes.http_client import TeamMemoryHttpClient

admin = TeamMemoryHttpClient("http://127.0.0.1:3000", os.environ["ADMIN_TOKEN"])

result = admin.call_tool("memory.resolveConflict", {
    "clientMutationId": "manual-conflict-resolution",
    "commit": {"id": "commit:manual-conflict-resolution"},
    "conflictIds": [os.environ["CONFLICT_ID"]],
    "resolutionKind": "take_incoming",
})

print(json.dumps(result, indent=2))
'@ | py -
```

Recall or search after resolution:

```powershell
@'
import json
import os
from src.adapters.hermes.http_client import HermesTeamMemoryProvider

provider = HermesTeamMemoryProvider.from_http(
    "http://127.0.0.1:3000",
    os.environ["HERMES_B_TOKEN"],
)

context = provider.recall_context(
    "What is the current manual conflict procedure?",
    session_id="hermes-b",
    limit=8,
)

print(json.dumps(context, indent=2))
'@ | py -
```

Expected result:

- Resolution creates an explicit resolution commit.
- The conflict status becomes resolved.
- If `take_incoming` was used, recall/search should now surface candidate B.
- If `keep_target` was used, recall/search should continue surfacing candidate A.

## 16. Final Acceptance Checklist

Mark v1 manual Hermes smoke as passed only if all of these are true:

- The server starts from a clean local runtime and passes `/live` and `/ready`.
- The single-Hermes local smoke passes before the server starts.
- Hermes sessions authenticate only by bearer token.
- Hermes payloads cannot override `userId`, `agentId`, `rootEntityId`, or
  `taskScope`.
- Read-only Hermes cannot see or execute write tools.
- Writer Hermes can capture success and failure paths.
- Another Hermes client can recall captured success and failure paths.
- Raw resources can be imported, explicitly ingested, and searched.
- History records the bootstrap, writes, imports, captures, conflicts, and
  resolution commits.
- A stale cross-client write creates an unresolved cloud conflict.
- Before resolution, the active branch remains unchanged.
- After administrator resolution, recall/search reflects the chosen resolution.

## Cleanup

Stop the server with `Ctrl+C`, then remove the manual runtime if desired:

```powershell
docker compose stop qdrant
Remove-Item -Recurse -Force .data\manual
```
