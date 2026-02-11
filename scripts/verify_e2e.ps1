#!/usr/bin/env pwsh
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$script:Wrangler = $null
$script:Root = Split-Path -Parent $PSScriptRoot
$script:Log = Join-Path $script:Root ".tmp\e2e_smoke.log"
$script:BaseUrl = ""
$script:CurlExe = ""

function Get-EnvValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )
  return [Environment]::GetEnvironmentVariable($Name)
}

function Import-DotEnv {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-Path $Path)) {
    return
  }

  foreach ($rawLine in Get-Content $Path) {
    $line = $rawLine.Trim()
    if ($line -and -not $line.StartsWith("#")) {
      $eq = $line.IndexOf("=")
      if ($eq -gt 0) {
        $name = $line.Substring(0, $eq).Trim()
        $value = $line.Substring($eq + 1)
        [Environment]::SetEnvironmentVariable($name, $value)
      }
    }
  }
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter()]
    [string[]]$Arguments = @()
  )

  $display = Format-CommandForLog -FilePath $FilePath -Arguments $Arguments
  Write-Host ">> $display"
  & $FilePath @Arguments
  $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
  if ($exitCode -ne 0) {
    throw "Command failed ($exitCode): $display"
  }
}

function Cleanup {
  if ($null -ne $script:Wrangler) {
    try {
      if (-not $script:Wrangler.HasExited) {
        Stop-Process -Id $script:Wrangler.Id -ErrorAction SilentlyContinue
      }
    } catch {
      # best-effort cleanup
    }
  }
}

function Tail-Logs {
  if (Test-Path $script:Log) {
    Get-Content $script:Log -Tail 200
  }
}

function Redact-Headers {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Text
  )
  $masked = [System.Text.RegularExpressions.Regex]::Replace(
    $Text,
    '(?im)^(Authorization\s*:\s*Bearer\s+)(\S+)\s*$',
    {
      param($m)
      return "$($m.Groups[1].Value)$(Mask-SecretValue -Value $m.Groups[2].Value)"
    }
  )
  $masked = [System.Text.RegularExpressions.Regex]::Replace(
    $masked,
    '(?im)^(x-api-key\s*:\s*)(\S+)\s*$',
    {
      param($m)
      return "$($m.Groups[1].Value)$(Mask-SecretValue -Value $m.Groups[2].Value)"
    }
  )
  return $masked
}

function Mask-SecretValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value
  )
  $raw = $Value.Trim()
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return "***redacted***"
  }
  if ($raw.Length -le 10) {
    $left = $raw.Substring(0, [Math]::Min(2, $raw.Length))
    $right = $raw.Substring([Math]::Max(0, $raw.Length - [Math]::Min(2, $raw.Length)))
    return "$left...$right"
  }
  return "{0}...{1}" -f $raw.Substring(0, 6), $raw.Substring($raw.Length - 4)
}

function Mask-HeaderValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Header
  )
  $line = $Header.Trim()

  $auth = [System.Text.RegularExpressions.Regex]::Match($line, '^(?i)(Authorization\s*:\s*Bearer\s+)(\S+)\s*$')
  if ($auth.Success) {
    return "$($auth.Groups[1].Value)$(Mask-SecretValue -Value $auth.Groups[2].Value)"
  }

  $xApi = [System.Text.RegularExpressions.Regex]::Match($line, '^(?i)(x-api-key\s*:\s*)(\S+)\s*$')
  if ($xApi.Success) {
    return "$($xApi.Groups[1].Value)$(Mask-SecretValue -Value $xApi.Groups[2].Value)"
  }

  return $Header
}

function Format-CommandForLog {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter()]
    [string[]]$Arguments = @()
  )
  if ($Arguments.Count -eq 0) {
    return $FilePath
  }

  $safeArgs = New-Object System.Collections.Generic.List[string]
  for ($i = 0; $i -lt $Arguments.Count; $i++) {
    $arg = $Arguments[$i]
    if (($arg -eq "-H" -or $arg -eq "--header") -and ($i + 1) -lt $Arguments.Count) {
      $safeArgs.Add($arg)
      $safeArgs.Add((Mask-HeaderValue -Header $Arguments[$i + 1]))
      $i++
      continue
    }
    $safeArgs.Add($arg)
  }
  return "$FilePath $($safeArgs -join ' ')"
}

function Get-StatusCodeFromHeaders {
  param(
    [Parameter(Mandatory = $true)]
    [string]$HeaderFile
  )

  $statusLine = Get-Content $HeaderFile | Where-Object { $_ -match "^HTTP/" } | Select-Object -Last 1
  if (-not $statusLine) {
    throw "Unable to parse HTTP status from headers file"
  }
  $parts = $statusLine -split "\s+"
  if ($parts.Length -lt 2) {
    throw "Malformed HTTP status line: $statusLine"
  }
  return [int]$parts[1]
}

function Invoke-MaskSelfTest {
  $sampleBearer = "mn_live_SAMPLE_TOKEN_NOT_REAL"
  $sampleHeader = "x-api-key: mn_live_TEST_TOKEN_DO_NOT_USE"
  $preview = Format-CommandForLog -FilePath "curl.exe" -Arguments @(
    "-sS",
    "-H", "Authorization: Bearer $sampleBearer",
    "-H", $sampleHeader,
    "https://example.test/healthz"
  )
  Write-Host $preview

  $headerDump = @(
    "HTTP/1.1 401 Unauthorized",
    "Authorization: Bearer $sampleBearer",
    $sampleHeader
  ) -join "`n"
  $maskedDump = Redact-Headers -Text $headerDump
  Write-Host $maskedDump

  if ($preview -match 'mn_live_[A-Za-z0-9_-]{10,}') {
    throw "Mask self-test failed: bearer/x-api-key leaked in command preview"
  }
  if ($maskedDump -match 'mn_live_[A-Za-z0-9_-]{10,}') {
    throw "Mask self-test failed: bearer/x-api-key leaked in header redaction"
  }
}

function Call-Health {
  $headerFile = [System.IO.Path]::GetTempFileName()
  $bodyFile = [System.IO.Path]::GetTempFileName()

  try {
    Write-Host "-> GET /healthz"
    $args = @("-sS", "-D", $headerFile, "-o", $bodyFile, "$script:BaseUrl/healthz")
    Invoke-Checked -FilePath $script:CurlExe -Arguments $args
    $status = Get-StatusCodeFromHeaders -HeaderFile $headerFile
    if ($status -ne 200) {
      Write-Host "Expected 200 got $status for /healthz"
      Write-Host "Headers:"
      Write-Host (Redact-Headers -Text (Get-Content $headerFile -Raw))
      Write-Host "Body:"
      Write-Host (Get-Content $bodyFile -Raw)
      throw "GET /healthz failed"
    }
  } finally {
    Remove-Item $headerFile, $bodyFile -ErrorAction SilentlyContinue
  }
}

function Call-Api {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Method,
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [int]$ExpectedStatus,
    [Parameter()]
    [string]$Body = "",
    [Parameter()]
    [string]$AssertProp = ""
  )

  $headerFile = [System.IO.Path]::GetTempFileName()
  $bodyFile = [System.IO.Path]::GetTempFileName()

  try {
    Write-Host "-> $Method $Path"
    $args = @(
      "-sS",
      "-D", $headerFile,
      "-o", $bodyFile,
      "-X", $Method,
      "$script:BaseUrl$Path",
      "-H", "Authorization: Bearer $($env:E2E_API_KEY)"
    )
    if (-not [string]::IsNullOrEmpty($Body)) {
      $args += @("-H", "Content-Type: application/json", "--data", $Body)
    }
    Invoke-Checked -FilePath $script:CurlExe -Arguments $args

    $status = Get-StatusCodeFromHeaders -HeaderFile $headerFile
    if ($status -ne $ExpectedStatus) {
      Write-Host "Expected $ExpectedStatus got $status"
      Write-Host "Headers:"
      Write-Host (Redact-Headers -Text (Get-Content $headerFile -Raw))
      Write-Host "Body:"
      Write-Host (Get-Content $bodyFile -Raw)
      throw "Unexpected status for $Method $Path"
    }

    if (-not [string]::IsNullOrEmpty($AssertProp)) {
      $json = Get-Content $bodyFile -Raw | ConvertFrom-Json
      if (-not ($json.PSObject.Properties.Name -contains $AssertProp)) {
        throw "Validation failed: missing property $AssertProp"
      }
      if ($null -eq $json.$AssertProp) {
        throw "Validation failed: property $AssertProp is null"
      }
    }
  } finally {
    Remove-Item $headerFile, $bodyFile -ErrorAction SilentlyContinue
  }
}

try {
  if ((Get-EnvValue -Name "E2E_MASK_SELF_TEST") -eq "1") {
    Invoke-MaskSelfTest
    exit 0
  }

  Set-Location $script:Root
  if (-not (Test-Path ".tmp")) {
    New-Item -ItemType Directory ".tmp" | Out-Null
  }
  Set-Content -Path $script:Log -Value ""

  Import-DotEnv -Path (Join-Path $script:Root ".env.e2e")

  if ([string]::IsNullOrWhiteSpace($env:E2E_API_KEY) -and -not [string]::IsNullOrWhiteSpace($env:MEMORYNODE_API_KEY)) {
    $env:E2E_API_KEY = $env:MEMORYNODE_API_KEY
  }

  if ([string]::IsNullOrWhiteSpace($env:E2E_API_KEY)) {
    throw "Missing required env vars: E2E_API_KEY (or MEMORYNODE_API_KEY)"
  }

  if ([string]::IsNullOrWhiteSpace($env:BASE_URL)) {
    $script:BaseUrl = "https://api-staging.memorynode.ai"
  } else {
    $script:BaseUrl = $env:BASE_URL
  }

  $isLocal = $script:BaseUrl -match "^http://(127\.0\.0\.1|localhost):"

  if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    $script:CurlExe = "curl.exe"
  } elseif (Get-Command curl -CommandType Application -ErrorAction SilentlyContinue) {
    $script:CurlExe = "curl"
  } else {
    throw "curl executable not found in PATH"
  }

  if ($isLocal) {
    $requiredLocal = @("E2E_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "API_KEY_SALT")
    $missing = @()
    foreach ($name in $requiredLocal) {
      if ([string]::IsNullOrWhiteSpace((Get-EnvValue -Name $name))) {
        $missing += $name
      }
    }
    if ($missing.Count -gt 0) {
      throw "Missing required env vars for local dev smoke: $($missing -join ', ')"
    }

    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ($listener.LocalEndpoint).Port
    $listener.Stop()

    $env:PORT = "$port"
    if ([string]::IsNullOrWhiteSpace($env:EMBEDDINGS_MODE)) {
      $env:EMBEDDINGS_MODE = "stub"
    }

    $wranglerToml = Join-Path $script:Root "apps/api/wrangler.toml"
    if (-not (Test-Path $wranglerToml)) {
      throw "ERROR: wrangler.toml not found at $wranglerToml"
    }
    if (-not (Select-String -Path $wranglerToml -Pattern "durable_objects" -Quiet)) {
      throw "ERROR: wrangler.toml is missing durable_objects section (expected RATE_LIMIT_DO)"
    }
    if (-not (Select-String -Path $wranglerToml -Pattern 'binding\s*=\s*"RATE_LIMIT_DO"' -Quiet)) {
      throw "ERROR: wrangler.toml is missing durable_objects binding RATE_LIMIT_DO"
    }

    Write-Host "Starting API dev server on port $port..."
    $script:Wrangler = Start-Process -FilePath "pnpm" `
      -ArgumentList @("--filter", "@memorynode/api", "run", "dev", "--", "--port", "$port", "--log-level", "error") `
      -WorkingDirectory $script:Root `
      -RedirectStandardOutput $script:Log `
      -RedirectStandardError $script:Log `
      -PassThru
    Start-Sleep -Milliseconds 500

    if ($script:Wrangler.HasExited -and $script:Wrangler.ExitCode -ne 0) {
      Tail-Logs
      throw "wrangler dev exited early with code $($script:Wrangler.ExitCode)"
    }

    Write-Host -NoNewline "Waiting for /healthz"
    $healthy = $false
    for ($i = 0; $i -lt 60; $i++) {
      if ($script:Wrangler.HasExited) {
        Write-Host " failed"
        Tail-Logs
        throw "wrangler dev exited before healthz was ready"
      }
      try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$port/healthz" -Method Get -TimeoutSec 2
        if ($resp.StatusCode -eq 200) {
          $healthy = $true
          break
        }
      } catch {
        # retry
      }
      Write-Host -NoNewline "."
      Start-Sleep -Seconds 1
    }

    if (-not $healthy) {
      Write-Host " failed"
      Tail-Logs
      throw "healthz not ready"
    }
    Write-Host " ok"

    $script:BaseUrl = "http://127.0.0.1:$port"
    Write-Host "Base URL (local dev): $script:BaseUrl"
  } else {
    Write-Host "Base URL (remote): $script:BaseUrl"
  }

  Call-Health
  Call-Api -Method "POST" -Path "/v1/memories" -ExpectedStatus 200 -Body '{"user_id":"e2e-user","text":"hello e2e memory","namespace":"e2e"}' -AssertProp "memory_id"
  Call-Api -Method "POST" -Path "/v1/search" -ExpectedStatus 200 -Body '{"user_id":"e2e-user","namespace":"e2e","query":"hello","top_k":3}' -AssertProp "results"
  Call-Api -Method "POST" -Path "/v1/context" -ExpectedStatus 200 -Body '{"user_id":"e2e-user","namespace":"e2e","query":"hello"}' -AssertProp "context_text"
  Call-Api -Method "GET" -Path "/v1/usage/today" -ExpectedStatus 200 -AssertProp "day"

  Write-Host "E2E smoke passed."
  exit 0
} catch {
  $msg = if ($_.Exception -and $_.Exception.Message) { $_.Exception.Message } else { $_ | Out-String }
  [Console]::Error.WriteLine("E2E smoke failed: $msg")
  Tail-Logs
  exit 1
} finally {
  Cleanup
}
