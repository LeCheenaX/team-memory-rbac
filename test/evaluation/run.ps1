$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$ComposeArgs = @(
  "-f", (Join-Path $RepoRoot "compose.yaml"),
  "-f", (Join-Path $RepoRoot "compose.hermes.yaml")
)
$EvaluationData = Join-Path $RepoRoot ".data\evaluation"
$EvaluationLabel = if ([string]::IsNullOrWhiteSpace($env:HERMES_EVAL_LABEL)) {
  "hermes-local-configured-model"
} else {
  $env:HERMES_EVAL_LABEL
}

Push-Location $RepoRoot
try {
  docker info | Out-Null
  node --experimental-strip-types test/evaluation/prepare.mjs
  New-Item -ItemType Directory -Force (Join-Path $EvaluationData "results") | Out-Null

  docker compose @ComposeArgs build hermes-local
  if ($LASTEXITCODE -ne 0) { throw "Failed to build the project hermes-local test container." }

  & (Join-Path $PSScriptRoot "reset.ps1") -SkipBuild

  docker compose @ComposeArgs run --rm `
    -e BOOTSTRAP_USER_PASSWORD=local-evaluation-only `
    hermes-local npm --prefix /opt/team-memory-rbac run bootstrap:root-admin -- `
    --config /workspace/config/team-memory.hermes-local.json
  if ($LASTEXITCODE -ne 0) { throw "Failed to bootstrap the hermes-local Team Memory session." }

  docker compose @ComposeArgs run --rm hermes-local check
  if ($LASTEXITCODE -ne 0) { throw "hermes-local check failed. Complete docs/02-config/配置文档-local.md first." }

  docker compose @ComposeArgs run --rm hermes-local hermes memory status
  if ($LASTEXITCODE -ne 0) { throw "The existing Hermes memory provider is not ready." }

  docker compose @ComposeArgs run --rm `
    --volume "${EvaluationData}:/evaluation" `
    -e "HERMES_EVAL_LABEL=$EvaluationLabel" `
    hermes-local node --experimental-strip-types /opt/team-memory-rbac/test/evaluation/run.mjs
  if ($LASTEXITCODE -ne 0) { throw "Hermes memory evaluation failed." }
} finally {
  Pop-Location
}
