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

The Test 1 setup runs before `HERMES_A_TOKEN` and `HERMES_B_TOKEN` exist. The
Compose file must therefore allow `hermes-local` commands to parse and run
without server-client tokens. Test 1 uses the active session file at
`/root/.hermes/team-memory-session.json`; `TEAM_MEMORY_TOKEN` is only a
low-level override.

Most setup commands below use `docker compose run --rm`. Those commands create
one-shot containers and Docker removes each container when its command exits.
That is expected. The state that must survive is stored in named volumes:

- `hermes-local-home` is mounted at `/root/.hermes` and keeps Hermes config,
  API keys, sessions, logs, and gateway state.
- `hermes-local-workspace` is mounted at `/workspace` and keeps the Test 1 local
  Team Memory database and CAS files.

Do not wait for `check`, `bootstrap:root-admin`, or `team -- agents onboard` to
turn into a Hermes chat session. The conversation begins only after a command
like `docker compose -f compose.yaml -f compose.hermes.yaml run --rm
hermes-local hermes` opens the Hermes chat UI.

Hermes must be configured through its real memory-provider seam, not through a
mock script. The Hermes container installs a real user memory plugin named
`team_memory` into `/root/.hermes/plugins/team_memory/`. Activate that plugin
with `hermes memory setup team_memory`; do not ask the chatting agent to import
or execute `HermesTeamMemoryProvider` directly.

The plugin chooses only the connector path from container environment:

- `TEAM_MEMORY_MODE=local` uses the local no-server runtime through
  `HermesTeamMemoryProvider.from_local(...)` and the checked-in
  `config/team-memory.hermes-local.json` runtime configuration.
- `TEAM_MEMORY_MODE=http` uses the Team Memory HTTP service through
  `HermesTeamMemoryProvider.from_http(...)`.

Do not configure the memory runtime with environment variables. Runtime mode,
libSQL, CAS, Qdrant, and embedding provider settings must live in a Team Memory
config JSON file. The local Hermes test uses `runtimeMode: "Dev"` with an
explicit deterministic embedding provider URL in
`config/team-memory.hermes-local.json`.

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
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local check
```

The `check` command exits after validating the Hermes binary and Team Memory
adapter import. It is not the interactive Hermes session.

Choose a local root admin password for this test run. Keep it for the duration
of the manual test. Team Memory stores the active session under
`/root/.hermes/team-memory-session.json`, so closing PowerShell does not require
copying or saving a token.

```powershell
$env:BOOTSTRAP_USER_PASSWORD = "<test local admin password>"
```

Bootstrap the local root inside the Hermes container:

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local npm --prefix /opt/team-memory-rbac run bootstrap:root-admin -- --config config/team-memory.hermes-local.json
```

The bootstrap command logs in `user:test1-admin` automatically. To verify the
login flow from a user's point of view, run interactive login:

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local npm --prefix /opt/team-memory-rbac run team -- --config config/team-memory.hermes-local.json login
```

Team Memory prompts `请输入用户名:`. Enter `user:test1-admin` and press Enter.
It then prompts `请输入密码:`. Enter the test password and press Enter. The
command returns `登录成功` when the password is correct, `该用户不存在` after an
unknown user name, and `密码错误` after an incorrect password.

For one-shot container login, pass the credentials after the npm script name:

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local npm --prefix /opt/team-memory-rbac run login user:test1-admin $env:BOOTSTRAP_USER_PASSWORD
```

For a test account named `admin` with password `adminpswd`, the same one-shot
shape is:

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local npm --prefix /opt/team-memory-rbac run login admin adminpswd
```

Do not set `HERMES_A_TOKEN` or `HERMES_B_TOKEN` for Test 1. Those are Test 2
server-client tokens and are created only after the Team Memory HTTP server is
bootstrapped.

Create a read-only user for the RBAC denial pass. This is still setup; the
denial itself must be tested by logging out, logging in as this user, and
talking to Hermes.

```powershell
$env:TEST1_READONLY_PASSWORD = "<test read-only password>"
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local npm --prefix /opt/team-memory-rbac run team -- --config config/team-memory.hermes-local.json members create user:test1-readonly Test1ReadOnly $env:TEST1_READONLY_PASSWORD role-researcher
```

To switch identities later:

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local npm --prefix /opt/team-memory-rbac run team -- logout
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local npm --prefix /opt/team-memory-rbac run login user:test1-admin $env:BOOTSTRAP_USER_PASSWORD
```

### Configure Hermes Native Settings

Before the first conversation, run Hermes' own setup flow once. This configures
Hermes API keys, model settings, and any Hermes-native preferences under
`/root/.hermes`, which persists in the `hermes-local-home` Docker volume even
though the setup container is removed.

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local hermes setup
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local hermes config
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local hermes memory setup team_memory
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local hermes memory status
```

If Hermes requires editing `config.yaml`, use the Hermes config command it
provides:

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local hermes config edit
```

Pass condition:

- `hermes setup` completes without leaving missing API key or model settings.
- `hermes config` shows a usable Hermes configuration under `/root/.hermes`.
- `hermes memory status` shows `Provider: team_memory` and reports the plugin
  as installed and available.

### Start The Real Hermes Container

Start Hermes while logged in as `user:test1-admin`. This is the first command in Test 1
where you should expect to talk to Hermes. Keep this terminal attached for the
conversation transcript.

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local hermes
```

Do not configure Team Memory from inside the chat by asking Hermes to import a
Python class. Team Memory must already be active through `hermes memory setup
team_memory` before this command starts. If Hermes exits, rerun the same
command; `/root/.hermes` and `/workspace` state remain in the named volumes.

Before continuing, ask Hermes:

```text
Show me which long-term memory provider is active. Then use the provider to
show my Team Memory identity, the memory tools visible to this session, and the
available Team Memory entity/tag catalog if a catalog tool is exposed.
```

Pass condition:

- Hermes reports `team_memory` as the active external long-term memory provider.
- The identity uses `root:test1-local`.
- The visible tool set includes read/search/write memory capability for the
  active admin session.
- If `memory.catalog` or an equivalent Team Memory catalog command is visible,
  Hermes can list current entity identities and tags before narrowing later
  searches by `entityIds`, `tagsAny`, or `tagsNone`.

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

Reset the Hermes conversation before testing recall. This must start a new
Hermes session so the answer cannot be satisfied from the model's short-term
conversation context.

```text
/reset
```

After Hermes confirms the new session, ask:

```text
How does Test 1 set up? Use long-term memory before answering.
```

Pass condition: Hermes recalls the container/no-server/local Team Memory fact
from Team Memory, not from the previous chat context. A passing answer must be
grounded in the provider-injected Team Memory context or an explicit
Team Memory tool result and must include a stored memory id or provenance. If
Hermes answers only from the earlier conversation without a reset, the recall
check has not been performed.

3. Memory management through Hermes:

```text
Search your Team Memory entries for "Test 1 local Hermes". Show the relevant
stored memory metadata, then add a short follow-up memory that says the manual
acceptance artifact is the Hermes transcript.
```

Pass condition: Hermes searches existing memory and captures the follow-up
through the provider. Any `team_memory_search` error such as a missing
`userPrompt`/query parameter fails this step; fix the provider/tool schema
before continuing. A successful raw search response should include
`"tag": "memory-context"` or a `<team-memory-context ...>` block, and it must
include at least one stored memory id for the original Test 1 container/local
Team Memory fact. It is acceptable for the results to also include later
self-referential recall or inspection turns, but those follow-up records alone
do not prove the original memory was retrieved. Tool responses must keep a
stable top-level shape; any variable entity or branch metadata should appear
under `extra`, not as ad hoc fields invented by the model.

Do not use `team_memory_capture` as a raw file import path. Conversation
memories are captured from the Hermes dialogue. Raw files or documents must be
imported through the Resource/CAS path and then indexed by automatic or
explicit resource ingestion.

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

Stop Hermes, switch the stored local account to the read-only user, and start
Hermes again:

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local npm --prefix /opt/team-memory-rbac run team -- logout
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local npm --prefix /opt/team-memory-rbac run login user:test1-readonly $env:TEST1_READONLY_PASSWORD
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
$env:BOOTSTRAP_USER_PASSWORD = "<test server admin password>"
npm.cmd run bootstrap:root-admin -- --config config/team-memory.server-local.json
```

Save the returned admin token for this PowerShell session. If the env var is
lost later, rerun the same bootstrap command with the same
`BOOTSTRAP_USER_PASSWORD`; it will issue a fresh token for
`session:test2-admin`.

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
npm.cmd run team -- --config config/team-memory.server-local.json agents onboard agent:test2-hermes-a delegation:test2-hermes-a session:test2-hermes-a 2030-01-01T00:00:00.000Z
npm.cmd run team -- --config config/team-memory.server-local.json agents onboard agent:test2-hermes-b delegation:test2-hermes-b session:test2-hermes-b 2030-01-01T00:00:00.000Z
```

Save the returned tokens:

```powershell
$env:HERMES_A_TOKEN = "<Hermes A agent token>"
$env:HERMES_B_TOKEN = "<Hermes B agent token>"
```

Create a read-only client for denial testing:

```powershell
npm.cmd run team -- --config config/team-memory.server-local.json agents onboard agent:test2-hermes-readonly delegation:test2-hermes-readonly session:test2-hermes-readonly 2030-01-01T00:00:00.000Z read-only
$env:HERMES_READONLY_TOKEN = "<Hermes read-only agent token>"
```

### Start Hermes A And Hermes B

Run Hermes' native setup once for each server-mode client. Hermes A and Hermes B
use separate `/root/.hermes` volumes, so each client needs its own API key/model
configuration.

Terminal A setup:

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-a hermes setup
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-a hermes config
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-a hermes memory setup team_memory
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-a hermes memory status
```

Terminal B setup:

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-b hermes setup
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-b hermes config
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-b hermes memory setup team_memory
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-b hermes memory status
```

Terminal A:

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-a hermes
```

Terminal B:

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-b hermes
```

Before starting each chat session, confirm `hermes memory status` shows
`Provider: team_memory`.

Ask both Hermes sessions:

```text
Show the active memory provider, my Team Memory identity, and the memory tools
visible to this session.
```

Pass condition:

- Hermes A and Hermes B both identify `root:test2-server`.
- Both use the `team_memory` external provider pointed at `http://service:3000`.
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
npm.cmd run team -- --config config/team-memory.server-local.json members list
npm.cmd run team -- --config config/team-memory.server-local.json delegations list
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
npm.cmd run team -- --config config/team-memory.server-local.json conflicts list
npm.cmd run team -- --config config/team-memory.server-local.json conflicts resolve <conflict-id> take_incoming
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
