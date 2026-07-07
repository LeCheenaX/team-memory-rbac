# Real Hermes Container

This repo includes a Docker image for running the real Hermes Agent installer
inside a Linux container.

The image uses the official Linux installer:

```sh
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

It also vendors this repository at `/opt/team-memory-rbac` so Hermes can import
the Team Memory adapter:

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

## Run Real Hermes

First start the Team Memory server stack:

```powershell
docker compose up --build -d libsql qdrant object-store service
```

Create two agent session tokens with the manual bootstrap/onboarding flow, then
export them:

```powershell
$env:HERMES_A_TOKEN = "<agent session token for Hermes A>"
$env:HERMES_B_TOKEN = "<agent session token for Hermes B>"
```

Start Hermes A:

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-a hermes
```

Start Hermes B in another terminal:

```powershell
docker compose -f compose.yaml -f compose.hermes.yaml run --rm hermes-b hermes
```

Both containers receive:

```txt
TEAM_MEMORY_URL=http://service:3000
TEAM_MEMORY_TOKEN=<their own token>
PYTHONPATH=/opt/team-memory-rbac
```

## Notes

- These are real Hermes containers, not Team Memory adapter mocks.
- The Team Memory adapter is available inside the container, but Hermes still
  has to be configured at its memory-provider seam to use
  `HermesTeamMemoryProvider`.
- `hermes-a` and `hermes-b` have separate Docker volumes for Hermes home and
  workspace state.
