param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("hermes-local", "hermes-a", "hermes-b")]
  [string]$Target,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ComposeFiles = @("-f", "compose.yaml", "-f", "compose.hermes.yaml")
$InitiallyRunningServices = @()
$DependenciesToStop = @()

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
    $InitiallyRunningServices = @(& docker compose @ComposeFiles ps --status running --services)
    if ($LASTEXITCODE -ne 0) { throw "Unable to inspect running Docker Compose services." }
  }

  Invoke-Docker (@("compose") + $ComposeFiles + @("rm", "-sf", $Target))

  if ($Target -eq "hermes-local") {
    Invoke-Docker (@("compose") + $ComposeFiles + @("build", "hermes-local"))
    $DependenciesToStop = if ($DryRun -or $InitiallyRunningServices -notcontains "qdrant") {
      @("qdrant")
    } else {
      @()
    }
    Invoke-Docker (@("compose") + $ComposeFiles + @("up", "-d", "qdrant"))
    Invoke-Docker (@("compose") + $ComposeFiles + @(
      "run", "--rm", "hermes-local", "node", "/opt/team-memory-rbac/scripts/clear-test-memory.mjs",
      "--config", "/workspace/config/team-memory.hermes-local.json"
    ))
    Write-Host "Non-core memory for hermes-local was cleared."
  } else {
    Invoke-Docker (@("compose") + $ComposeFiles + @("build", "service"))
    Invoke-Docker (@("compose") + $ComposeFiles + @("stop", "service", "object-store"))
    $DependenciesToStop = @("libsql", "qdrant") | Where-Object {
      $DryRun -or $InitiallyRunningServices -notcontains $_
    }
    Invoke-Docker (@("compose") + $ComposeFiles + @("up", "-d", "libsql", "qdrant"))
    Invoke-Docker (@("compose") + $ComposeFiles + @(
      "run", "--rm", "--no-deps", "service", "node", "/app/scripts/clear-test-memory.mjs",
      "--config", "/app/config/team-memory.service.json"
    ))

    $clearObjectStore = 'resolved="$(cd /data && pwd -P)"; test "$resolved" = "/data"; find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +'
    Invoke-Docker (@("compose") + $ComposeFiles + @(
      "run", "--rm", "--no-deps", "--entrypoint", "sh", "object-store", "-c", $clearObjectStore
    ))
    Write-Host "Shared server memory used by $Target was cleared."
    Write-Host "Hermes A and B share this server memory; the other client sees the same cleared state."
  }

  Write-Host "Users, credentials, admins, roles, assignments, sessions, and RBAC audit data were preserved."
} finally {
  try {
    if ($DependenciesToStop.Count -gt 0) {
      Invoke-Docker (@("compose") + $ComposeFiles + @("stop") + $DependenciesToStop)
    }
  } catch {
    Write-Warning "Failed to stop temporary dependencies: $_"
  } finally {
    Pop-Location
  }
}

