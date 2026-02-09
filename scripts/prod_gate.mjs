#!/usr/bin/env node
/**
 * Cross-platform prod gate runner.
 * - Windows: runs PowerShell gate.
 * - Others: runs bash gate.
 * Fails fast if node/pnpm missing.
 */

import { execSync } from "node:child_process";
import os from "node:os";

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function ensurePnpm() {
  try {
    execSync("pnpm -v", { stdio: "ignore" });
  } catch {
    fail("pnpm not found in PATH. Install via corepack (corepack enable) or add pnpm to PATH.");
  }
}

function run(cmd, missingHint) {
  console.log(`$ ${cmd}`);
  try {
    execSync(cmd, { stdio: "inherit" });
  } catch (err) {
    if (err?.code === "ENOENT") {
      fail(missingHint ?? `Command not found: ${cmd}`);
    }
    process.exit(err?.status ?? 1);
  }
}

function main() {
  ensurePnpm();
  const isWindows = os.platform() === "win32";
  if (isWindows) {
    run(
      "pwsh -ExecutionPolicy Bypass -File scripts/prod_gate.ps1",
      "PowerShell (pwsh) not found. Install PowerShell 7+ or run the bash gate on non-Windows.",
    );
  } else {
    run("bash scripts/prod_gate.sh", "bash not found. Install bash (or run the PowerShell gate on Windows).");
  }
}

main();
