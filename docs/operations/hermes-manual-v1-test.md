# Hermes V1 Manual Test Flow

This guide is intentionally split into two tests.

Test 1 is local-only: one Hermes-facing client, no Team Memory server, no sync,
no cloud conflict flow. It verifies the core local memory behavior that must
keep working when the server is down.

Test 2 is shared-server: multiple clients connect to one Team Memory service.
It verifies server-side permission administration, synchronization, shared
recall, and conflict resolution.

Do not mix the two tests. If a step starts `npm run dev:server`, it belongs to
Test 2.

## Common Setup

Run from the repository root.

```powershell
git clone <repository-url> team-memory-rbac
cd team-memory-rbac
npm.cmd install
npm.cmd run check
docker compose up -d qdrant
curl.exe http://127.0.0.1:6333/healthz
```

Use `py -` in the examples below. If your machine does not have the Python
launcher, replace `py -` with `python -`.

## Test 1: Single Local Hermes, No Server

### Goal

Verify local core behavior without any Team Memory HTTP server:

- explicit local bootstrap;
- local RBAC decisions;
- manual permission configuration through local admin CLI/runtime;
- Hermes-facing local adapter can write and recall memory;
- read-only delegation cannot write;
- forged identity fields are rejected;
- no synchronization, no multi-client conflict, no server APIs.

This test may use local libSQL, filesystem CAS, and Qdrant. It must not start
`npm.cmd run dev:server`.

### 1. Create Local Test Runtime

```powershell
New-Item -ItemType Directory -Force .data\test1-local-hermes | Out-Null

$env:LIBSQL_URL = "file:./.data/test1-local-hermes/team-memory.db"
$env:CAS_BACKEND = "filesystem"
$env:CAS_DIRECTORY = "./.data/test1-local-hermes/cas"
$env:QDRANT_URL = "http://127.0.0.1:6333"

$env:BOOTSTRAP_ROOT_ENTITY_ID = "root:test1-local"
$env:BOOTSTRAP_USER_ID = "user:test1-admin"
$env:BOOTSTRAP_USER_NAME = "Test 1 Local Admin"
$env:BOOTSTRAP_SESSION_ID = "session:test1-admin"
$env:BOOTSTRAP_SESSION_EXPIRES_AT = "2030-01-01T00:00:00.000Z"

npm.cmd run bootstrap:root-admin
```

Save the returned admin token:

```powershell
$env:ADMIN_TOKEN = "<paste sessionToken here>"
```

### 2. Manually Configure Local Permissions

All commands in this section operate directly on the local runtime. No server is
running.

Check the admin identity:

```powershell
npm.cmd run team -- login
```

List current role assignments:

```powershell
npm.cmd run team -- members list
```

Create a read/write Hermes agent session:

```powershell
npm.cmd run team -- agents onboard agent:test1-hermes-writer delegation:test1-hermes-writer session:test1-hermes-writer 2030-01-01T00:00:00.000Z
```

Save the returned session token:

```powershell
$env:LOCAL_HERMES_TOKEN = "<paste writer session token here>"
```

Create a read-only Hermes agent session manually. This verifies that permissions
are configurable, not hard-coded into the local test script.

```powershell
$readOnly = '[{"action":"read","resourceKind":"memory_entity","constraints":{"allowRootEntityMutation":true}},{"action":"search","resourceKind":"memory_entity","constraints":{"allowRootEntityMutation":true}}]'
npm.cmd run team -- agents onboard agent:test1-hermes-readonly delegation:test1-hermes-readonly session:test1-hermes-readonly 2030-01-01T00:00:00.000Z $readOnly
$env:LOCAL_HERMES_READONLY_TOKEN = "<paste read-only session token here>"
```

Expected result:

- The writer agent has write/search/import tools.
- The read-only delegation exists and contains only read/search memory
  permissions.
- No HTTP endpoint has been started.

### 3. Manually Call Local Memory Tools By Session Token

This is the direct no-server check. It uses a Hermes/Python local client, the
writer session token, and the local libSQL/Qdrant/CAS runtime. It does not call
`http://127.0.0.1:3000`.

```powershell
@'
import json
import os
from src.adapters.hermes.http_client import HermesTeamMemoryProvider, TeamMemoryLocalClient

client = TeamMemoryLocalClient(os.environ["LOCAL_HERMES_TOKEN"])
provider = HermesTeamMemoryProvider.from_local(os.environ["LOCAL_HERMES_TOKEN"])

print("identity")
print(json.dumps(client.identity(), indent=2))

print("tools")
print(json.dumps(client.list_tools(), indent=2))

captured = provider.add(
    [
        {"role": "user", "content": "Can local Hermes remember without a server?"},
        {"role": "assistant", "content": "Yes. This path used only the local runtime, local token, libSQL, Qdrant, and filesystem CAS."},
    ],
    user_id="test1-local-hermes",
    outcome="success",
)
print("captured")
print(json.dumps(captured, indent=2))

recalled = provider.search(
    "local Hermes remember without a server",
    user_id="test1-local-hermes",
    limit=8,
)
print("recalled")
print(json.dumps(recalled, indent=2))

direct = client.call_tool("memory.search", {
    "query": {
        "kind": "entity",
        "text": "local runtime local token libSQL Qdrant filesystem CAS",
        "limit": 8,
    },
})
print("direct memory.search")
print(json.dumps(direct, indent=2))
'@ | py -
```

Expected result:

- `identity.rootEntityId` is `root:test1-local`;
- `tools` includes `memory.write` and `memory.search`;
- `captured.status` is `captured`;
- `recalled.memoryIds` is not empty;
- `direct memory.search.value.items` returns local memory results;
- no Team Memory HTTP server is running.

### 4. Run Single-Hermes Local Smoke

This checks the Hermes-facing local adapter against the local gateway only.

```powershell
$env:LOCAL_HERMES_AGENT_ID = "agent:test1-hermes-smoke"
$env:LOCAL_HERMES_DELEGATION_ID = "delegation:test1-hermes-smoke"
$env:LOCAL_HERMES_SESSION_ID = "session:test1-hermes-smoke"
$env:LOCAL_HERMES_SESSION_EXPIRES_AT = "2030-01-01T00:00:00.000Z"

npm.cmd run hermes:local-smoke
```

Expected result:

- `mode` is `single_hermes_local_no_http_no_sync`.
- `principal.rootEntityId` is `root:test1-local`.
- `visibleTools` includes `memory.write` and `memory.search`.
- `search.value.items` contains the local Hermes smoke memory.
- `forgedIdentityRejected` is `true`.

### 5. Manually Check Read-Only Denial

Use the read-only Hermes session and attempt a write without any server:

```powershell
$env:LOCAL_SESSION_TOKEN = $env:LOCAL_HERMES_READONLY_TOKEN
npm.cmd run local-memory-tool -- tools

$payload = '{"clientMutationId":"test1-readonly-denied","action":"write_entity","resourceKind":"memory_entity","commit":{"id":"commit:test1-readonly-denied"},"operation":{"kind":"create_entity","id":"operation:test1-readonly-denied","entity":{"id":"entity:test1-readonly-denied","rootEntityId":"root:test1-local","status":"active","createdAt":"2026-07-07T00:00:00.000Z","updatedAt":"2026-07-07T00:00:00.000Z"}}}'
npm.cmd run local-memory-tool -- call memory.write $payload
```

Expected result:

- `tools` does not list `memory.write`.
- the write returns a denied decision rather than creating memory.

### Test 1 Pass Criteria

Test 1 passes only if:

- no Team Memory server was started;
- local bootstrap used explicit operator-chosen IDs;
- local admin CLI can list and change RBAC assignments/delegations;
- a specific local session token can manually call memory tools and receive
  local libSQL/Qdrant/CAS-backed results;
- Hermes local smoke can write and recall memory;
- forged identity fields are rejected;
- no sync, `/sync/pull`, cloud conflict, or multi-client behavior is evaluated.

## Test 2: Multi Client + Server

### Goal

Verify production v1 shared-server behavior:

- one Team Memory service;
- multiple clients using server-authenticated session tokens;
- only server-side administrator credentials can configure users/roles/delegations;
- ordinary client/agent tokens cannot configure permissions;
- shared memory recall works across clients;
- sync state is exposed by the server;
- conflicting writes create an unresolved cloud conflict;
- only an administrator can resolve the conflict.

### 1. Create Server Runtime And Bootstrap Admin

Use a separate database from Test 1.

```powershell
New-Item -ItemType Directory -Force .data\test2-server | Out-Null

$env:LIBSQL_URL = "file:./.data/test2-server/team-memory.db"
$env:CAS_BACKEND = "filesystem"
$env:CAS_DIRECTORY = "./.data/test2-server/cas"
$env:QDRANT_URL = "http://127.0.0.1:6333"
$env:PORT = "3000"

$env:BOOTSTRAP_ROOT_ENTITY_ID = "root:test2-server"
$env:BOOTSTRAP_USER_ID = "user:test2-admin"
$env:BOOTSTRAP_USER_NAME = "Test 2 Server Admin"
$env:BOOTSTRAP_SESSION_ID = "session:test2-admin"
$env:BOOTSTRAP_SESSION_EXPIRES_AT = "2030-01-01T00:00:00.000Z"

npm.cmd run bootstrap:root-admin
$env:ADMIN_TOKEN = "<paste sessionToken here>"
```

### 2. Start Server

In a second terminal with the same runtime environment:

```powershell
$env:LIBSQL_URL = "file:./.data/test2-server/team-memory.db"
$env:CAS_BACKEND = "filesystem"
$env:CAS_DIRECTORY = "./.data/test2-server/cas"
$env:QDRANT_URL = "http://127.0.0.1:6333"
$env:PORT = "3000"
npm.cmd run dev:server
```

Check server health:

```powershell
curl.exe http://127.0.0.1:3000/live
curl.exe http://127.0.0.1:3000/ready
curl.exe -H "Authorization: Bearer $env:ADMIN_TOKEN" http://127.0.0.1:3000/identity
```

### 3. Configure Client Permissions Only From Server Admin

This section must be run with `ADMIN_TOKEN`. Treat this as the server-side
operator/admin surface.

```powershell
@'
import json
import os
from urllib import request

BASE = "http://127.0.0.1:3000"
ADMIN_TOKEN = os.environ["ADMIN_TOKEN"]

def post(path, payload, token):
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
    {"action": "read", "resourceKind": "memory_entity", "constraints": {"allowRootEntityMutation": True}},
    {"action": "search", "resourceKind": "memory_entity", "constraints": {"allowRootEntityMutation": True}},
    {"action": "write_entity", "resourceKind": "memory_entity", "constraints": {"allowRootEntityMutation": True}},
    {"action": "write_entity_branch", "resourceKind": "memory_entity_branch", "constraints": {"allowRootEntityMutation": True}},
    {"action": "import_resource", "resourceKind": "resource", "constraints": {"allowRootEntityMutation": True}},
    {"action": "index_resource", "resourceKind": "resource", "constraints": {"allowRootEntityMutation": True}},
    {"action": "read", "resourceKind": "resource", "constraints": {"allowRootEntityMutation": True}},
    {"action": "search", "resourceKind": "resource_chunk", "constraints": {"allowRootEntityMutation": True}},
]

read_only_permissions = [
    {"action": "read", "resourceKind": "memory_entity", "constraints": {"allowRootEntityMutation": True}},
    {"action": "search", "resourceKind": "memory_entity", "constraints": {"allowRootEntityMutation": True}},
]

sessions = {}
for name, permissions in [
    ("hermes-a", writer_permissions),
    ("hermes-b", writer_permissions),
    ("hermes-readonly", read_only_permissions),
]:
    result = post("/admin/agents/onboard", {
        "agentId": f"agent:test2:{name}",
        "delegationId": f"delegation:test2:{name}",
        "sessionId": f"session:test2:{name}",
        "sessionExpiresAt": "2030-01-01T00:00:00.000Z",
        "displayName": name,
        "permissions": permissions,
    }, ADMIN_TOKEN)
    sessions[name] = result["session"]["token"]

print(json.dumps(sessions, indent=2))
'@ | py -
```

Save tokens:

```powershell
$env:HERMES_A_TOKEN = "<paste hermes-a token>"
$env:HERMES_B_TOKEN = "<paste hermes-b token>"
$env:HERMES_READONLY_TOKEN = "<paste hermes-readonly token>"
```

### 4. Verify Client Tokens Cannot Configure Permissions

Try to configure RBAC using an ordinary client token:

```powershell
@'
import json
import os
from urllib import request
from urllib.error import HTTPError

BASE = "http://127.0.0.1:3000"
token = os.environ["HERMES_A_TOKEN"]

payload = {
    "agentId": "agent:test2:illegal",
    "delegationId": "delegation:test2:illegal",
    "sessionId": "session:test2:illegal",
    "sessionExpiresAt": "2030-01-01T00:00:00.000Z",
}

req = request.Request(
    BASE + "/admin/agents/onboard",
    data=json.dumps(payload).encode("utf-8"),
    method="POST",
    headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
)

try:
    request.urlopen(req, timeout=30)
    raise SystemExit("FAIL: client token configured permissions")
except HTTPError as error:
    print(error.code, error.read().decode("utf-8"))
'@ | py -
```

Expected result:

- HTTP status is `403`.
- Error explains that agents cannot perform administrator actions.

This is the key Test 2 rule: clients can use memory according to their granted
permissions, but permission configuration is server-admin only.

### 5. Verify Client Tool Visibility

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

- writer clients see write/import/search tools;
- read-only client does not see write/import tools.

### 6. Shared Memory Recall

Hermes A captures a success path:

```powershell
@'
import json
import os
from src.adapters.hermes.http_client import HermesTeamMemoryProvider

provider = HermesTeamMemoryProvider.from_http("http://127.0.0.1:3000", os.environ["HERMES_A_TOKEN"])
result = provider.add(
    [
        {"role": "user", "content": "How do we run Test 2?"},
        {"role": "assistant", "content": "Successful path: server admin configures permissions, clients use memory, conflicts are resolved by admin."},
    ],
    user_id="hermes-a",
    outcome="success",
)
print(json.dumps(result, indent=2))
'@ | py -
```

Hermes B recalls it:

```powershell
@'
import json
import os
from src.adapters.hermes.http_client import HermesTeamMemoryProvider

provider = HermesTeamMemoryProvider.from_http("http://127.0.0.1:3000", os.environ["HERMES_B_TOKEN"])
context = provider.recall_context("How do we run Test 2?", session_id="hermes-b", limit=8)
print(json.dumps(context, indent=2))
'@ | py -
```

Expected result:

- Hermes B sees memory captured by Hermes A.

### 7. Server Sync State

```powershell
@'
import json
import os
from src.adapters.hermes.http_client import TeamMemoryHttpClient

client = TeamMemoryHttpClient("http://127.0.0.1:3000", os.environ["HERMES_A_TOKEN"])
print(json.dumps(client.call_tool("memory.syncPull", {"knownCommitWatermark": 0}), indent=2))
'@ | py -
```

Expected result:

- server returns authorized sync events for `root:test2-server`;
- no unrelated root data is included.

### 8. Conflict Creation And Admin Resolution

Hermes A and Hermes B create conflicting writes:

```powershell
@'
import json
import os
from src.adapters.hermes.http_client import TeamMemoryHttpClient, TeamMemoryHttpError

BASE = "http://127.0.0.1:3000"
NOW = "2026-07-07T00:00:00.000Z"
a = TeamMemoryHttpClient(BASE, os.environ["HERMES_A_TOKEN"])
b = TeamMemoryHttpClient(BASE, os.environ["HERMES_B_TOKEN"])

entity = a.call_tool("memory.write", {
    "clientMutationId": "test2-conflict-create-entity",
    "action": "write_entity",
    "resourceKind": "memory_entity",
    "commit": {"id": "commit:test2-conflict-create-entity"},
    "operation": {
        "kind": "create_entity",
        "id": "operation:test2-conflict-create-entity",
        "entity": {
            "id": "entity:test2-conflict",
            "rootEntityId": "root:test2-server",
            "currentBranchId": "branch:test2-conflict-a",
            "status": "active",
            "createdAt": NOW,
            "updatedAt": NOW,
        },
    },
})
base_head = entity["write"]["commit"]["id"]

a.call_tool("memory.write", {
    "clientMutationId": "test2-conflict-a",
    "expectedHeadCommitId": base_head,
    "action": "write_entity_branch",
    "resourceKind": "memory_entity_branch",
    "commit": {"id": "commit:test2-conflict-a"},
    "operation": {
        "kind": "create_entity_branch",
        "id": "operation:test2-conflict-a",
        "branch": {
            "id": "branch:test2-conflict-a",
            "entityId": "entity:test2-conflict",
            "rootEntityId": "root:test2-server",
            "branchRef": "main",
            "title": "Conflict candidate A",
            "description": "A keeps the target branch.",
            "tags": ["test2-conflict"],
            "importance": 1,
            "confidence": 0.8,
            "status": "active",
            "createdAt": NOW,
            "updatedAt": NOW,
        },
    },
})

try:
    b.call_tool("memory.write", {
        "clientMutationId": "test2-conflict-b",
        "expectedHeadCommitId": base_head,
        "action": "write_entity_branch",
        "resourceKind": "memory_entity_branch",
        "commit": {"id": "commit:test2-conflict-b"},
        "operation": {
            "kind": "create_entity_branch",
            "id": "operation:test2-conflict-b",
            "branch": {
                "id": "branch:test2-conflict-b",
                "entityId": "entity:test2-conflict",
                "rootEntityId": "root:test2-server",
                "branchRef": "main",
                "title": "Conflict candidate B",
                "description": "B is incoming.",
                "tags": ["test2-conflict"],
                "importance": 1,
                "confidence": 0.8,
                "status": "active",
                "createdAt": NOW,
                "updatedAt": NOW,
            },
        },
    })
except TeamMemoryHttpError as error:
    print("expected conflict", error.status, error.code)

print(json.dumps(a.call_tool("memory.conflicts", {}), indent=2))
'@ | py -
```

Resolve with admin token only:

```powershell
@'
import json
import os
from src.adapters.hermes.http_client import TeamMemoryHttpClient

admin = TeamMemoryHttpClient("http://127.0.0.1:3000", os.environ["ADMIN_TOKEN"])
conflicts = admin.call_tool("memory.conflicts", {})
conflict_id = conflicts["conflicts"][0]["id"]
result = admin.call_tool("memory.resolveConflict", {
    "clientMutationId": "test2-conflict-resolution",
    "commit": {"id": "commit:test2-conflict-resolution"},
    "conflictIds": [conflict_id],
    "resolutionKind": "take_incoming",
})
print(json.dumps(result, indent=2))
'@ | py -
```

Expected result:

- B's stale write creates a conflict;
- active branch remains unchanged until resolution;
- admin resolution creates an explicit resolution commit;
- client tokens must not be used for permission configuration.

## Cleanup

```powershell
docker compose stop qdrant
Remove-Item -Recurse -Force .data\test1-local-hermes
Remove-Item -Recurse -Force .data\test2-server
```
