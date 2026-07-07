#!/usr/bin/env bash
set -euo pipefail

export PYTHONPATH="/opt/team-memory-rbac:${PYTHONPATH:-}"
export TEAM_MEMORY_URL="${TEAM_MEMORY_URL:-http://service:3000}"

if [[ "${1:-}" == "check" ]]; then
  command -v hermes
  hermes --version || true
  python - <<'PY'
from src.adapters.hermes.http_client import HermesTeamMemoryProvider
print("team-memory-rbac Hermes adapter import ok")
PY
  exit 0
fi

exec "$@"
