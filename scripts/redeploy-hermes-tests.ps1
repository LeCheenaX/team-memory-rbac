param(
  [switch]$DryRun,
  [switch]$NoCache
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ComposeFiles = @("-f", "compose.yaml", "-f", "compose.hermes.yaml")
$HermesServices = @("hermes-local", "hermes-a", "hermes-b")
$BuildMarkerPath = Join-Path $RepoRoot ".team-memory-build-id"

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
$markerCreated = $false
try {
  $revision = (& git rev-parse --short=12 HEAD 2>$null)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($revision)) { $revision = "working-tree" }
  $buildId = "$revision-$(Get-Date -Format 'yyyyMMddHHmmss')"

  if (-not $DryRun) {
    & docker info | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Docker is unavailable. Start Docker Desktop and retry." }
    Invoke-Docker (@("compose") + $ComposeFiles + @("config", "--quiet"))
    [System.IO.File]::WriteAllText($BuildMarkerPath, "$buildId`n")
    $markerCreated = $true
  }

  # A running `docker compose run` session keeps its old image. Stop those
  # test clients, but deliberately retain every named volume.
  Invoke-Docker (@("compose") + $ComposeFiles + @("rm", "-sf") + $HermesServices)

  $build = @("compose") + $ComposeFiles + @("build", "--pull")
  if ($NoCache) { $build += "--no-cache" }
  $build += @("service") + $HermesServices
  Invoke-Docker $build

  Invoke-Docker (@("compose") + $ComposeFiles + @(
    "up", "-d", "--force-recreate", "libsql", "qdrant", "object-store", "service"
  ))

  $serviceCheck = 'test "$(cat /app/.team-memory-build-id)" = "' + $buildId + '"'
  Invoke-Docker (@("compose") + $ComposeFiles + @("exec", "-T", "service", "sh", "-lc", $serviceCheck))

  foreach ($service in $HermesServices) {
    $hermesCheck =
      'test "$(cat /opt/team-memory-rbac/.team-memory-build-id)" = "' + $buildId +
      '" && python -c "from src.adapters.hermes.http_client import HermesTeamMemoryProvider"'
    Invoke-Docker (@("compose") + $ComposeFiles + @(
      "run", "--rm", "--no-deps", $service, "sh", "-lc", $hermesCheck
    ))
  }

  Write-Host "Team Memory $buildId is deployed and verified in hermes-local, hermes-a, and hermes-b."
  Write-Host "Hermes settings, sessions, RBAC data, and test memories were preserved."
} finally {
  if ($markerCreated -and (Test-Path $BuildMarkerPath)) {
    Remove-Item -LiteralPath $BuildMarkerPath -Force
  }
  Pop-Location
}

