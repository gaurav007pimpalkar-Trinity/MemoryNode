#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { redactSecret, scanWranglerTomlSecrets } from "./lib/secret_scan_core.mjs";

const filePath = path.resolve("apps/api/wrangler.toml");
if (!fs.existsSync(filePath)) {
  console.error(`wrangler.toml not found at ${filePath}`);
  process.exit(1);
}

const raw = fs.readFileSync(filePath, "utf8");
const findings = scanWranglerTomlSecrets(raw, filePath);
if (findings.length > 0) {
  console.error("wrangler.toml secret guard failed. Secret-like values detected:");
  for (const finding of findings) {
    console.error(
      ` - ${finding.file}:${finding.line} [${finding.section}] ${finding.key} (${finding.reason}; ${redactSecret(finding.value)})`,
    );
  }
  console.error("Move secrets to Cloudflare managed secrets (wrangler secret put <NAME>).");
  process.exit(1);
}

console.log("wrangler.toml vars/env vars blocks are clean (no secret-like values).");
