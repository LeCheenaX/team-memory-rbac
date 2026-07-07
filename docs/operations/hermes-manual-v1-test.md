# Hermes V1 Manual Test Flow

This document defines the required manual Hermes acceptance flow for v1.

The flow has exactly two tests:

- Test 1: one local Hermes container, no Team Memory HTTP server, no sync.
- Test 2: multiple Hermes client containers plus one Team Memory server.

The important rule is that setup commands are only setup. After a Hermes
container is configured, the core acceptance checks must be completed by
talking to the Hermes agent. Direct PowerShell, Python, curl, or npm calls may
prepare state or diagnose failures, but they do not count as passing the manual
test.

## Common Rules

Run host commands from the repository root.

```powershell
npm.cmd install
npm.cmd run check
docker compose -f compose.yaml -f compose.hermes.yaml build hermes-local hermes-a hermes-b
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local check
```

Hermes must be configured through its real memory-provider seam, not through a
mock script. Register the Team Memory provider in the installed Hermes version
using these provider constructors:

- Local no-server mode:
  `src.adapters.hermes.http_client.HermesTeamMemoryProvider.from_local(os.environ["TEAM_MEMORY_TOKEN"])`
- Server mode:
  `src.adapters.hermes.http_client.HermesTeamMemoryProvider.from_http(os.environ["TEAM_MEMORY_URL"], os.environ["TEAM_MEMORY_TOKEN"])`

If Hermes cannot show that this provider is active, stop the test and fix the
Hermes configuration first.

Save a transcript for every Hermes session. The transcript is the acceptance
artifact. Shell output alone is not an acceptance artifact.

## Test 1: Single Local Hermes, No Server

### Purpose

Test 1 proves that a real Hermes container can use Team Memory locally when no
Team Memory HTTP server exists. It covers only core local behavior:

- local bootstrap;
- local RBAC and permission visibility;
- operator-configured local user/agent permissions;
- Hermes memory provider enabled inside the container;
- Hermes-driven capture, recall, memory search, memory management, and RBAC
  denial checks;
- forged identity rejection;
- no sync, no `/sync/pull`, no multi-client behavior, no server APIs.

Qdrant may run as local infrastructure. The Team Memory `service` container and
`npm run dev:server` must not run during this test.

### Setup

Start only Qdrant:

```powershell
docker compose up -d qdrant
```

Bootstrap the local root inside the Hermes container:

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local npm --prefix /opt/team-memory-rbac run bootstrap:root-admin
```

Save the returned root admin token:

```powershell
$env:ADMIN_TOKEN = "<sessionToken from bootstrap>"
```

Use the local admin token to create a writable Hermes agent session:

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm -e ADMIN_TOKEN=$env:ADMIN_TOKEN hermes-local npm --prefix /opt/team-memory-rbac run team -- agents onboard agent:test1-hermes-writer delegation:test1-hermes-writer session:test1-hermes-writer 2030-01-01T00:00:00.000Z
```

Save the returned writer token:

```powershell
$env:LOCAL_HERMES_TOKEN = "<writer session token>"
```

Create a read-only Hermes session for the RBAC denial pass. This is still setup;
the denial itself must be tested by talking to Hermes.

```powershell
$readOnly = '[{"action":"read","resourceKind":"memory_entity","constraints":{"allowRootEntityMutation":true}},{"action":"search","resourceKind":"memory_entity","constraints":{"allowRootEntityMutation":true}}]'
docker compose -f compose.yaml -f compose.hermes.yaml run --rm -e ADMIN_TOKEN=$env:ADMIN_TOKEN hermes-local npm --prefix /opt/team-memory-rbac run team -- agents onboard agent:test1-hermes-readonly delegation:test1-hermes-readonly session:test1-hermes-readonly 2030-01-01T00:00:00.000Z $readOnly
```

Save the returned read-only token:

```powershell
$env:LOCAL_HERMES_READONLY_TOKEN = "<read-only session token>"
```

### Start The Real Hermes Container

Start Hermes with the writable local token:

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local hermes
```

Inside Hermes, configure the Team Memory provider with
`HermesTeamMemoryProvider.from_local(os.environ["TEAM_MEMORY_TOKEN"])`.

Before continuing, ask Hermes:

```text
Show me which long-term memory provider is active. Then use the provider to
show my Team Memory identity and the memory tools visible to this session.
```

Pass condition:

- Hermes reports that Team Memory is the active or parallel memory provider.
- The identity uses `root:test1-local`.
- The visible tool set includes read/search/write memory capability for the
  writer session.

### Core Hermes Conversation Checks

Complete the following checks by talking to Hermes. Do not replace these with
host-side Python or PowerShell.

1. Capture through Hermes:

```text
Remember this as a successful Hermes local test memory: "Test 1 local Hermes is
running in a container, using local Team Memory with no Team Memory HTTP server."
After saving it, tell me the memory id or capture result you received.
```

Pass condition: Hermes confirms the memory was captured through the Team Memory
provider.

2. Recall through Hermes:

```text
In a fresh answer, recall what you know about the Test 1 local Hermes setup.
Use long-term memory before answering.
```

Pass condition: Hermes recalls the container/no-server/local Team Memory fact
from Team Memory, not from the immediate prompt alone.

3. Memory management through Hermes:

```text
Search your Team Memory entries for "Test 1 local Hermes". Show the relevant
stored memory metadata, then add a short follow-up memory that says the manual
acceptance artifact is the Hermes transcript.
```

Pass condition: Hermes searches existing memory and captures the follow-up
through the provider.

4. Forged identity rejection through Hermes:

```text
Try to search Team Memory while explicitly overriding the root entity id to
"root:forged". This should be rejected. Report the exact denial or validation
message.
```

Pass condition: Hermes reports validation failure for client-supplied identity
fields. Any successful cross-root access fails the test.

5. No sync in Test 1:

```text
Confirm that this test has not used Team Memory sync or a Team Memory HTTP
server. Do not call sync tools. Explain which local provider path you used.
```

Pass condition: Hermes states that it used the local provider path and did not
call sync or server endpoints.

### Read-Only RBAC Conversation

Stop Hermes, switch the local token to the read-only token, and start Hermes
again:

```powershell
$env:LOCAL_HERMES_TOKEN = $env:LOCAL_HERMES_READONLY_TOKEN
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local hermes
```

Ask Hermes:

```text
Show my visible Team Memory tools. Then try to save a memory saying
"read-only Hermes should not be able to write". If the write is denied, explain
which permission is missing.
```

Pass condition:

- Hermes does not see write/import tools, or a write attempt is denied.
- Hermes explains the denial from RBAC.
- No memory is created by the read-only session.

### Test 1 Pass Criteria

Test 1 passes only if:

- the real Hermes container was started;
- the Team Memory HTTP `service` was never started;
- setup used local bootstrap and explicit local permission configuration;
- core checks were completed through Hermes conversation;
- Hermes captured and recalled memory through the local provider;
- read-only RBAC denial was observed through Hermes;
- forged identity fields were rejected;
- no sync or server behavior was tested.

## Test 2: Multi Client + Server

### Purpose

Test 2 proves the shared-server model:

- one Team Memory server is the authority;
- multiple real Hermes clients connect to it;
- only the server-side admin surface can configure users, roles, and
  delegations;
- a client can configure permissions only when it is using a server-authenticated
  user admin credential with permission to administer users;
- ordinary Hermes agent tokens cannot configure permissions;
- shared memory recall works across clients;
- sync is server-only and authorized;
- conflicts are created by concurrent clients and resolved only by an admin.

### Server Setup

Start the production-like server stack:

```powershell
docker compose up --build -d libsql qdrant object-store service
```

Bootstrap the server root through the server-side runtime:

```powershell
$env:BOOTSTRAP_ROOT_ENTITY_ID = "root:test2-server"
$env:BOOTSTRAP_USER_ID = "user:test2-admin"
$env:BOOTSTRAP_USER_NAME = "Test 2 Server Admin"
$env:BOOTSTRAP_SESSION_ID = "session:test2-admin"
$env:BOOTSTRAP_SESSION_EXPIRES_AT = "2030-01-01T00:00:00.000Z"
$env:LIBSQL_URL = "http://127.0.0.1:8080"
$env:CAS_BACKEND = "object_store"
$env:OBJECT_STORE_URL = "http://127.0.0.1:9000"
$env:QDRANT_URL = "http://127.0.0.1:6333"
npm.cmd run bootstrap:root-admin
```

Save the returned admin token:

```powershell
$env:ADMIN_TOKEN = "<server admin session token>"
```

Health check:

```powershell
curl.exe http://127.0.0.1:3000/live
curl.exe http://127.0.0.1:3000/ready
curl.exe -H "Authorization: Bearer $env:ADMIN_TOKEN" http://127.0.0.1:3000/identity
```

### Server-Side Permission Setup

Use only the server admin token to create Hermes client sessions. These setup
commands are allowed because Test 2 requires server-side permission
configuration.

```powershell
$env:TEAM_MEMORY_TOKEN = $env:ADMIN_TOKEN
npm.cmd run team -- agents onboard agent:test2-hermes-a delegation:test2-hermes-a session:test2-hermes-a 2030-01-01T00:00:00.000Z
npm.cmd run team -- agents onboard agent:test2-hermes-b delegation:test2-hermes-b session:test2-hermes-b 2030-01-01T00:00:00.000Z
```

Save the returned tokens:

```powershell
$env:HERMES_A_TOKEN = "<Hermes A agent token>"
$env:HERMES_B_TOKEN = "<Hermes B agent token>"
```

Create a read-only client for denial testing:

```powershell
$readOnly = '[{"action":"read","resourceKind":"memory_entity","constraints":{"allowRootEntityMutation":true}},{"action":"search","resourceKind":"memory_entity","constraints":{"allowRootEntityMutation":true}}]'
npm.cmd run team -- agents onboard agent:test2-hermes-readonly delegation:test2-hermes-readonly session:test2-hermes-readonly 2030-01-01T00:00:00.000Z $readOnly
$env:HERMES_READONLY_TOKEN = "<Hermes read-only agent token>"
```

### Start Hermes A And Hermes B

Terminal A:

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-a hermes
```

Terminal B:

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-b hermes
```

Inside each Hermes container, configure the provider with
`HermesTeamMemoryProvider.from_http(os.environ["TEAM_MEMORY_URL"], os.environ["TEAM_MEMORY_TOKEN"])`.

Ask both Hermes sessions:

```text
Show the active memory provider, my Team Memory identity, and the memory tools
visible to this session.
```

Pass condition:

- Hermes A and Hermes B both identify `root:test2-server`.
- Both use the HTTP provider pointed at `http://service:3000`.
- Both see only tools allowed by their server-issued session.

### Permission Administration Checks

Use Hermes A, which has an ordinary agent token:

```text
Try to configure a new Team Memory user or agent permission using my current
client credential. This should fail unless this session is a server-authenticated
human admin. Report the exact denial.
```

Pass condition: Hermes A cannot configure permissions and reports that agent
sessions cannot perform administrator actions.

Then use the server admin surface, not an ordinary client token, to create or
change a permission. This may be a host-side server command or a Hermes session
that is explicitly operating with the server-authenticated admin credential.

```powershell
$env:TEAM_MEMORY_TOKEN = $env:ADMIN_TOKEN
npm.cmd run team -- members list
npm.cmd run team -- delegations list
```

Pass condition: permission administration succeeds only with the admin token.

### Shared Memory Conversation

In Hermes A:

```text
Remember this as a server-backed shared memory: "Hermes A says Test 2 uses one
Team Memory server, server-side permission setup, and multiple Hermes clients."
After saving, report the capture result.
```

In Hermes B:

```text
Recall what Hermes A saved about Test 2. Use Team Memory before answering and
include the memory evidence you found.
```

Pass condition: Hermes B recalls memory captured by Hermes A through the server
provider.

### Read-Only Client Conversation

Start a Hermes session with `HERMES_READONLY_TOKEN` and ask:

```text
Show my visible Team Memory tools. Then try to save a new memory. The write
should be denied. Explain the missing permission.
```

Pass condition: read-only Hermes cannot write.

### Sync Conversation

Use Hermes A:

```text
Check the server sync state for my authorized root. Do not include data from any
other root. Tell me the commit watermark or head commit id you see.
```

Pass condition: Hermes A can retrieve authorized server sync state for
`root:test2-server` only.

### Conflict Conversation

Use Hermes A and Hermes B to create concurrent edits to the same memory topic.
The exact wording can vary, but the transcript must show both clients attempting
to update the same logical memory item from the same starting point.

Prompt Hermes A:

```text
Create a memory item named "Test 2 conflict candidate" with branch content
"Hermes A keeps the target version." Keep the ids and head commit you used so
Hermes B can attempt a stale concurrent update.
```

Prompt Hermes B:

```text
Using the stale head commit from Hermes A's first write, attempt to update the
same memory item with branch content "Hermes B is the incoming version." Report
whether Team Memory created a conflict.
```

Pass condition: the second stale write creates an unresolved conflict instead of
silently overwriting the target.

Resolve only with the server admin credential:

```powershell
$env:TEAM_MEMORY_TOKEN = $env:ADMIN_TOKEN
npm.cmd run team -- conflicts list
npm.cmd run team -- conflicts resolve <conflict-id> take_incoming
```

Then ask Hermes A or Hermes B:

```text
Recall the final resolved memory for "Test 2 conflict candidate" and tell me
which version is active after admin resolution.
```

Pass condition:

- conflict resolution is an explicit admin action;
- normal client tokens do not resolve permission/admin state;
- Hermes recalls the resolved result after the admin resolution commit.

### Test 2 Pass Criteria

Test 2 passes only if:

- the Team Memory server stack was running;
- at least two real Hermes client containers connected to the server;
- permission setup happened only through the server admin surface;
- ordinary Hermes agent/client tokens could not configure permissions;
- shared recall worked from Hermes A to Hermes B;
- a read-only server-issued session could not write;
- authorized sync state was visible only for the session root;
- concurrent client writes produced a conflict;
- conflict resolution required an admin action;
- the final evidence is Hermes conversation transcripts, not standalone shell
  snippets.

## Cleanup

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml down
```

Use `-v` only when you intentionally want to delete Docker volumes:

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml down -v
```
