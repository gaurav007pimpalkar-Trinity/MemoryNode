#!/usr/bin/env node
import { execSync } from "node:child_process";
import os from "node:os";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, missingHint) {
  console.log(`$ ${command}`);
  try {
    execSync(command, { stdio: "inherit" });
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail(missingHint ?? `Command not found: ${command}`);
    }
    process.exit(error?.status ?? 1);
  }
}

if (os.platform() === "win32") {
  run(
    "pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify_e2e.ps1",
    "PowerShell (pwsh) not found. Install PowerShell 7+.",
  );
} else {
  run("bash scripts/verify_e2e.sh", "bash not found.");
}
