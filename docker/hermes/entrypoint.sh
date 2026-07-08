#!/usr/bin/env bash
set -euo pipefail

export PYTHONPATH="/opt/team-memory-rbac:${PYTHONPATH:-}"
export TEAM_MEMORY_URL="${TEAM_MEMORY_URL:-http://service:3000}"

if [[ "${LIBSQL_URL:-}" == file:* ]]; then
  db_path="${LIBSQL_URL#file:}"
  mkdir -p "$(dirname "$db_path")"
fi

if [[ -n "${CAS_DIRECTORY:-}" ]]; then
  mkdir -p "$CAS_DIRECTORY"
fi

mkdir -p "${HERMES_HOME:-/root/.hermes}/plugins/team_memory"
cp /opt/team-memory-rbac/adapters/hermes/team_memory_plugin/__init__.py \
  "${HERMES_HOME:-/root/.hermes}/plugins/team_memory/__init__.py"
cp /opt/team-memory-rbac/adapters/hermes/team_memory_plugin/plugin.yaml \
  "${HERMES_HOME:-/root/.hermes}/plugins/team_memory/plugin.yaml"

if [[ "${1:-}" == "check" ]]; then
  command -v hermes
  hermes --version || true
  python - <<'PY'
from src.adapters.hermes.http_client import HermesTeamMemoryProvider
print("team-memory-rbac Hermes adapter import ok")
PY
  cd /usr/local/lib/hermes-agent
  venv/bin/python - <<'PY'
from plugins.memory import discover_memory_providers, load_memory_provider
providers = [name for name, _, _ in discover_memory_providers()]
assert "team_memory" in providers, providers
assert load_memory_provider("team_memory") is not None
print("team-memory-rbac Hermes memory plugin ok")
PY
  exit 0
fi

exec "$@"
