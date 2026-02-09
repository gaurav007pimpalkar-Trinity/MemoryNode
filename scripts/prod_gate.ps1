#!/usr/bin/env pwsh
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (Test-Path ".env.gate") {
  Write-Host "[gate] loading .env.gate"
  Get-Content ".env.gate" | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' } | ForEach-Object {
    $parts = $_.Split("=", 2)
    if ($parts.Length -eq 2) {
      [Environment]::SetEnvironmentVariable($parts[0], $parts[1])
    }
  }
} else {
  Write-Host "[gate] .env.gate not found. Create it from .env.gate.example with required vars:"
  Write-Host "  DEPLOY_ENV, BASE_URL, DATABASE_URL (or SUPABASE_DB_URL), MEMORYNODE_API_KEY, DEPLOY_CONFIRM (prod), CLOUDFLARE_API_TOKEN (optional), DRY_RUN"
  exit 1
}

Write-Host "[gate] lint/typecheck/tests"
pnpm lint
pnpm typecheck
pnpm test

Write-Host "[gate] staging dry-run deploy"
$env:DEPLOY_ENV = "staging"
$env:DRY_RUN = "1"
pnpm deploy:staging

Write-Host "[gate] production dry-run deploy"
$env:DEPLOY_ENV = "production"
$env:DRY_RUN = "1"
$env:DEPLOY_CONFIRM = "memorynode-prod"
pnpm deploy:prod

Write-Host "[gate] complete"
