# Real Hermes Container

This repo includes a Docker image for running the real Hermes Agent installer
inside a Linux container.

The image uses the official Linux installer:

```sh
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

It also vendors this repository at `/opt/team-memory-rbac` so Hermes can import
the Team Memory adapter and installs a Hermes user memory plugin named
`team_memory` under `/root/.hermes/plugins/team_memory/`:

```python
from src.adapters.hermes.http_client import HermesTeamMemoryProvider
```

## Build The Hermes Image

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml build hermes-a
```

`hermes-a` and `hermes-b` use the same image.

## Check The Install

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-a check
```

Expected:

- `hermes` exists in `PATH`.
- `hermes --version` runs if the CLI exposes a version command.
- The Team Memory Hermes adapter import prints `adapter import ok`.

## Run Local No-Server Hermes

For Test 1, start only local infrastructure and run Hermes through the
`hermes-local` service. This service does not depend on the Team Memory HTTP
`service` and must run before `HERMES_A_TOKEN` or `HERMES_B_TOKEN` exist.

`docker compose run --rm` creates a one-shot container and removes that
container when the command exits. That is expected for setup commands. Persistent
Hermes state is in the `hermes-local-home` volume mounted at `/root/.hermes`;
local Team Memory state is in the `hermes-local-workspace` volume mounted at
`/workspace`.

```powershell
docker compose up -d qdrant
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local npm --prefix /opt/team-memory-rbac run team -- --config /workspace/config/team-memory.hermes-local.json setup
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local check
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local npm --prefix /opt/team-memory-rbac run bootstrap:root-admin -- --config /workspace/config/team-memory.hermes-local.json
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local hermes setup
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local hermes config
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local hermes memory setup team_memory
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local hermes memory status
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local hermes
```

The `setup`, `check`, and `config` commands exit after doing their setup work.
`hermes-local check` validates both the Hermes install and the activated Team
Memory runtime; before setup it must fail with `memory module is not active`.
The bootstrap command prompts for the local root admin password and writes the
session file that Hermes will use.
The interactive conversation begins when `hermes-local hermes` opens the Hermes
chat UI. Keep that terminal attached for the transcript.

The memory runtime itself is configured by
`/workspace/config/team-memory.hermes-local.json`, which lives in the persistent
`hermes-local-workspace` volume. The entrypoint copies the checked-in template
there on first use. That file declares `runtimeMode`, libSQL, CAS, Qdrant, and
an explicit embedding provider URL. `unitTest` is the only mode that may use
deterministic fake embeddings. `Dev` and `Production` must use a real HTTP
embedding provider. Run `team -- --config
/workspace/config/team-memory.hermes-local.json setup` before bootstrap or
login; setup prompts for the runtime and embedding settings, validates the
embedding model, and writes activation only after validation passes.

The bootstrap command writes the active Team Memory session to
`/root/.hermes/team-memory-session.json`, which persists in the
`hermes-local-home` volume. Use `team -- logout` and interactive
`team -- --config /workspace/config/team-memory.hermes-local.json login` to
switch accounts. Login also writes a
main-agent session into the same file. Hermes reads that main-agent session
automatically, so a logged-in container does not need a copied agent token.
`TEAM_MEMORY_TOKEN` remains a low-level one-command override, but the normal
Hermes flow should use the session file.

Activate the Team Memory external memory plugin with:

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local hermes memory setup team_memory
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local hermes memory status
```

The status command must show `Provider: team_memory`. Do not ask the chat agent
to import `HermesTeamMemoryProvider`; the chat process only uses providers
selected through Hermes' memory plugin system.

`hermes memory status` must report Team Memory as available only after the
session file contains a valid logged-in main-agent session with
`memory.catalog` permission. Missing login state, stale sessions, plain user
tokens, or sessions without read/catalog permission must keep the provider
unavailable instead of reporting a healthy memory module that later fails at
tool-call time.

Hermes' own setup flow writes API keys, model settings, and preferences under
`/root/.hermes`. If it asks you to edit the config file, run:

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-local hermes config edit
```

## Run Real Hermes Against Server

First start the Team Memory server stack:

```powershell
docker compose up --build -d libsql qdrant object-store
npm.cmd run team -- --config config/team-memory.server-local.json setup
docker compose up --build -d service
```

The server runtime is inactive until setup validates the configured real HTTP
embedding model and writes activation. Do not configure libSQL, CAS, Qdrant, or
embedding settings with environment variables.

For ordinary use, log in inside each Hermes container and let Team Memory write
`/root/.hermes/team-memory-session.json`. The session file holds both the user
session and the automatically issued main-agent session used by the Hermes
memory provider.

For long-running service-client tests that need fixed identities before a
container logs in, you may still pre-provision explicit service agent tokens and
export them:

```powershell
$env:HERMES_A_TOKEN = "<agent session token for Hermes A>"
$env:HERMES_B_TOKEN = "<agent session token for Hermes B>"
```

These tokens are an override for server-mode service clients. They are not
needed after a normal container login, and they are not needed for
`hermes-local` bootstrap or the Test 1 local conversation.

Start Hermes A:

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-a hermes setup
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-a hermes config
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-a hermes memory setup team_memory
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-a hermes memory status
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-a hermes
```

Start Hermes B in another terminal:

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-b hermes setup
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-b hermes config
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-b hermes memory setup team_memory
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-b hermes memory status
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-b hermes
```

Both containers receive:

```txt
TEAM_MEMORY_URL=http://service:3000
TEAM_MEMORY_TOKEN=<optional service-client override; normally empty after container login>
PYTHONPATH=/opt/team-memory-rbac
```

## Notes

- These are real Hermes containers, not Team Memory adapter mocks.
- The Team Memory adapter and npm dependencies are available inside the
  container, but Hermes still has to be configured at its memory-provider seam
  to use `HermesTeamMemoryProvider`.
- `hermes-a` and `hermes-b` have separate Docker volumes for Hermes home and
  workspace state.
- `hermes-local` has its own Hermes home and workspace volumes so Test 1 state
  does not mix with Test 2 clients.
