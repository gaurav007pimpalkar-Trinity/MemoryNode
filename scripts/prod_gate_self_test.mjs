#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const pwsh = process.platform === "win32" ? "pwsh.exe" : "pwsh";
const result = spawnSync(
  pwsh,
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/prod_gate.ps1"],
  {
    stdio: "inherit",
    env: { ...process.env, GATE_SELF_TEST: "1" },
  },
);

if (result.error) {
  console.error(`[gate-self-test] failed to start pwsh: ${result.error.message}`);
  process.exit(1);
}

if (result.status === 0) {
  console.error("[gate-self-test] expected non-zero exit when forcing gate failure");
  process.exit(1);
}

if (result.status === null) {
  console.error("[gate-self-test] gate process did not return an exit code");
  process.exit(1);
}

console.log(`[gate-self-test] pass: prod gate exited non-zero as expected (${result.status})`);
