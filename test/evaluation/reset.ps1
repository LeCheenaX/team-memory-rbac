param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$ComposeArgs = @(
  "-f", (Join-Path $RepoRoot "compose.yaml"),
  "-f", (Join-Path $RepoRoot "compose.hermes.yaml")
)

Push-Location $RepoRoot
try {
  docker info | Out-Null
  if (-not $SkipBuild) {
    docker compose @ComposeArgs build hermes-local
    if ($LASTEXITCODE -ne 0) { throw "Failed to build the project hermes-local test container." }
  }
  docker compose @ComposeArgs up -d --wait qdrant
  if ($LASTEXITCODE -ne 0) { throw "Failed to start the project Qdrant service." }

  docker compose @ComposeArgs run --rm hermes-local `
    node /opt/team-memory-rbac/test/evaluation/reset-memory.mjs `
    --config /workspace/config/team-memory.hermes-local.json
  if ($LASTEXITCODE -ne 0) { throw "Failed to clear hermes-local Team Memory." }

  Write-Host "Cleared Team Memory for root:test1-local. RBAC plus the existing Hermes provider, model, API keys, and downloaded evaluation data were preserved."
} finally {
  Pop-Location
}
