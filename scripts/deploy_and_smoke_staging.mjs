#!/usr/bin/env node
/**
 * Staging release check: real staging deploy then live smoke.
 * Loads .env.staging.smoke then .env.gate if present.
 */

import fs from "node:fs";
import { execSync } from "node:child_process";

const REQUIRED_STAGING_VARS = [
  "BASE_URL",
  "DATABASE_URL",
  "SUPABASE_URL",
  "API_KEY_SALT",
  "MASTER_ADMIN_TOKEN",
  "EMBEDDINGS_MODE",
  "MEMORYNODE_API_KEY",
];

function loadEnvFile(path) {
  if (!fs.existsSync(path)) return false;
  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [k, ...rest] = line.split("=");
    const v = rest.join("=");
    if (k && v && !(k in process.env)) {
      process.env[k.trim()] = v.trim();
    }
  }
  console.log(`[release-check] loaded ${path}`);
  return true;
}

function listMissing(vars) {
  return vars.filter((k) => {
    const v = process.env[k];
    return v === undefined || v === null || String(v).trim() === "";
  });
}

function run(cmd, env = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", env: { ...process.env, ...env } });
}

function main() {
  loadEnvFile(".env.staging.smoke");
  loadEnvFile(".env.gate");

  const missing = listMissing(REQUIRED_STAGING_VARS);
  if (missing.length > 0) {
    console.error("[release-check] missing required staging vars:", missing.join(", "));
    console.error("Create .env.staging.smoke from .env.staging.smoke.example and fill these values.");
    process.exit(1);
  }

  if (!process.env.DEPLOY_ENV) {
    process.env.DEPLOY_ENV = "staging";
  }
  process.env.DRY_RUN = ""; // ensure real deploy

  console.log("[release-check] Deploying to staging (real deploy)");
  run("node scripts/deploy_staging.mjs");

  console.log("[release-check] Post-deploy validation (staging)");
  run("node scripts/post_deploy_validate.mjs");

  console.log("[release-check] Running live staging smoke");
  run("node scripts/smoke_staging.mjs");

  console.log("✅ staging release check complete");
}

main();
