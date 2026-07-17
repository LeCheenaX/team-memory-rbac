param([switch]$DryRun)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ComposeFiles = @("-f", "compose.yaml", "-f", "compose.hermes.yaml")
$HermesServices = @("hermes-local", "hermes-a", "hermes-b")

function Format-Argument([string]$Value) {
  if ($Value -match '[\s"]') { return '"' + $Value.Replace('"', '\"') + '"' }
  return $Value
}

function Invoke-Docker([string[]]$Arguments) {
  $display = ($Arguments | ForEach-Object { Format-Argument $_ }) -join " "
  Write-Host "docker $display"
  if ($DryRun) { return }
  & docker @Arguments
  if ($LASTEXITCODE -ne 0) { throw "docker $display failed with exit code $LASTEXITCODE" }
}

Push-Location $RepoRoot
try {
  if (-not $DryRun) {
    & docker info | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Docker is unavailable. Start Docker Desktop and retry." }
    Invoke-Docker (@("compose") + $ComposeFiles + @("config", "--quiet"))
  }

  # Build the two maintenance runners so this works even when deployed images
  # predate the clear-test-memory CLI.
  Invoke-Docker (@("compose") + $ComposeFiles + @("build", "service", "hermes-local"))
  Invoke-Docker (@("compose") + $ComposeFiles + @("stop", "service"))
  Invoke-Docker (@("compose") + $ComposeFiles + @("rm", "-sf") + $HermesServices)
  Invoke-Docker (@("compose") + $ComposeFiles + @("up", "-d", "libsql", "qdrant", "object-store"))

  Invoke-Docker (@("compose") + $ComposeFiles + @(
    "run", "--rm", "hermes-local", "node", "--experimental-strip-types",
    "/opt/team-memory-rbac/scripts/clear-test-memory.mjs",
    "--config", "/workspace/config/team-memory.hermes-local.json"
  ))
  Invoke-Docker (@("compose") + $ComposeFiles + @(
    "run", "--rm", "--no-deps", "service", "node", "--experimental-strip-types",
    "/app/scripts/clear-test-memory.mjs", "--config", "/app/config/team-memory.service.json",
    "--skip-vectors", "--skip-filesystem-cas"
  ))

  Invoke-Docker (@("compose") + $ComposeFiles + @("up", "-d", "--force-recreate", "service"))
  Write-Host "Test memories were cleared from local and shared Hermes stores."
  Write-Host "Users, credentials, admins, roles, assignments, sessions, and RBAC audit data were preserved."
  Write-Host "Unreferenced immutable object-store CAS bytes were retained for lifecycle cleanup."
} finally {
  Pop-Location
}

