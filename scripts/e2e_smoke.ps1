#!/usr/bin/env pwsh
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

& (Join-Path $PSScriptRoot "verify_e2e.ps1") @args
