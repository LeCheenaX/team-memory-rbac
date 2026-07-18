#!/usr/bin/env bash
set -euo pipefail

export PYTHONPATH="/opt/team-memory-rbac:${PYTHONPATH:-}"
export TEAM_MEMORY_URL="${TEAM_MEMORY_URL:-http://service:3000}"
export TEAM_MEMORY_CONFIG_FILE="${TEAM_MEMORY_CONFIG_FILE:-/workspace/config/team-memory.hermes-local.json}"

mkdir -p /workspace/.data/test1-local-hermes/cas
mkdir -p "$(dirname "$TEAM_MEMORY_CONFIG_FILE")"
if [[ ! -f "$TEAM_MEMORY_CONFIG_FILE" ]]; then
  cp /opt/team-memory-rbac/config/team-memory.hermes-local.json "$TEAM_MEMORY_CONFIG_FILE"
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
  "$TEAM_MEMORY_SPACY_PYTHON" -m pip check
  node --experimental-strip-types --input-type=module <<'JS'
const { SpacyEntityExtractor } = await import(
  "file:///opt/team-memory-rbac/adapters/spacy/entity-extractor.ts"
);
const atoms = new SpacyEntityExtractor().extract(
  "Riverfront uses weekly reports and Mina owns them"
);
if (!Array.isArray(atoms) || atoms.length === 0) {
  throw new Error("spaCy extraction returned no atoms");
}
console.log("team-memory-rbac spaCy extraction ok", JSON.stringify(atoms));
JS
  cd /usr/local/lib/hermes-agent
  venv/bin/python - <<'PY'
from plugins.memory import discover_memory_providers, load_memory_provider
providers = [name for name, _, _ in discover_memory_providers()]
assert "team_memory" in providers, providers
assert load_memory_provider("team_memory") is not None
print("team-memory-rbac Hermes memory plugin ok")
PY
  npm --prefix /opt/team-memory-rbac run --silent runtime:check -- --config "$TEAM_MEMORY_CONFIG_FILE"
  exit 0
fi

exec "$@"
