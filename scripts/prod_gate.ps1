#!/usr/bin/env pwsh
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Cmd
  )

  Write-Host ">> $Cmd"
  Invoke-Expression $Cmd
  $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
  if ($exitCode -ne 0) {
    throw "Command failed ($exitCode): $Cmd"
  }
}

try {
  if ($env:GATE_SELF_TEST -eq "1") {
    Write-Host "[gate] self-test: forcing a failing command"
    Invoke-Checked 'node -e "process.exit(2)"'
    throw "GATE_SELF_TEST expected command failure, but command succeeded"
  }

  if (Test-Path ".env.gate") {
    Write-Host "[gate] loading .env.gate"
    Get-Content ".env.gate" | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' } | ForEach-Object {
      $parts = $_.Split("=", 2)
      if ($parts.Length -eq 2) {
        [Environment]::SetEnvironmentVariable($parts[0], $parts[1])
      }
    }
  } else {
    throw ".env.gate not found. Create it from .env.gate.example with required vars: DEPLOY_ENV, BASE_URL, DATABASE_URL (or SUPABASE_DB_URL), MEMORYNODE_API_KEY, DEPLOY_CONFIRM (prod), CLOUDFLARE_API_TOKEN (optional), DRY_RUN"
  }

  Write-Host "[gate] lint/typecheck/tests"
  Invoke-Checked "pnpm lint"
  Invoke-Checked "pnpm typecheck"
  Invoke-Checked "pnpm test"

  Write-Host "[gate] staging dry-run deploy"
  $env:DEPLOY_ENV = "staging"
  $env:DRY_RUN = "1"
  Invoke-Checked "pnpm deploy:staging"

  Write-Host "[gate] production dry-run deploy"
  $env:DEPLOY_ENV = "production"
  $env:DRY_RUN = "1"
  $env:DEPLOY_CONFIRM = "memorynode-prod"
  Invoke-Checked "pnpm deploy:prod"

  Write-Host "[gate] complete"
  exit 0
} catch {
  $message = if ($_.Exception -and $_.Exception.Message) { $_.Exception.Message } else { $_ | Out-String }
  Write-Error "[gate] failed: $message"
  $exitCode = if ($null -ne $LASTEXITCODE -and [int]$LASTEXITCODE -ne 0) { [int]$LASTEXITCODE } else { 1 }
  exit $exitCode
}
