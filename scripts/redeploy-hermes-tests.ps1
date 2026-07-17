param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("hermes-local", "hermes-a", "hermes-b")]
  [string]$Target,
  [switch]$DryRun,
  [switch]$NoCache
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ComposeFiles = @("-f", "compose.yaml", "-f", "compose.hermes.yaml")
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

  Invoke-Docker (@("compose") + $ComposeFiles + @("rm", "-sf", $Target))

  $buildTargets = if ($Target -eq "hermes-local") { @($Target) } else { @("service", $Target) }
  $build = @("compose") + $ComposeFiles + @("build", "--pull")
  if ($NoCache) { $build += "--no-cache" }
  $build += $buildTargets
  Invoke-Docker $build

  if ($Target -ne "hermes-local") {
    $serviceCheck = 'test "$(cat /app/.team-memory-build-id)" = "' + $buildId + '"'
    Invoke-Docker (@("compose") + $ComposeFiles + @(
      "run", "--rm", "--no-deps", "service", "sh", "-lc", $serviceCheck
    ))
  }

  $hermesCheck =
    'test "$(cat /opt/team-memory-rbac/.team-memory-build-id)" = "' + $buildId +
    '" && python -c "from src.adapters.hermes.http_client import HermesTeamMemoryProvider"'
  Invoke-Docker (@("compose") + $ComposeFiles + @(
    "run", "--rm", "--no-deps", $Target, "sh", "-lc", $hermesCheck
  ))

  Write-Host "Team Memory $buildId is rebuilt and verified for $Target only."
  Write-Host "No other Hermes target or dependency stack was started."
} finally {
  if ($markerCreated -and (Test-Path $BuildMarkerPath)) {
    Remove-Item -LiteralPath $BuildMarkerPath -Force
  }
  Pop-Location
}

