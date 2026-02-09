#!/usr/bin/env node
/**
 * Production release check: real prod deploy then live smoke.
 * Loads .env.prod.smoke then .env.gate if present.
 */

import fs from "node:fs";
import { execSync } from "node:child_process";

const REQUIRED_PROD_VARS = [
  "BASE_URL",
  "DATABASE_URL",
  "SUPABASE_URL",
  "API_KEY_SALT",
  "MASTER_ADMIN_TOKEN",
  "EMBEDDINGS_MODE",
  "MEMORYNODE_API_KEY",
  "DEPLOY_CONFIRM",
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
  console.log(`[release-check:prod] loaded ${path}`);
  return true;
}

function listMissing(vars) {
  return vars.filter((k) => {
    const v = process.env[k];
    return v === undefined || v === null || String(v).trim() === "";
  });
}

function requireConfirm() {
  const ok = process.env.DEPLOY_CONFIRM === "memorynode-prod";
  if (!ok) {
    console.error(
      'Set DEPLOY_CONFIRM="memorynode-prod" in .env.prod.smoke or env to allow production deploy.',
    );
    process.exit(1);
  }
}

function run(cmd, env = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", env: { ...process.env, ...env } });
}

function main() {
  loadEnvFile(".env.prod.smoke");
  loadEnvFile(".env.gate");

  const missing = listMissing(REQUIRED_PROD_VARS);
  if (missing.length > 0) {
    console.error("[release-check:prod] missing required prod vars:", missing.join(", "));
    console.error("Create .env.prod.smoke from .env.prod.smoke.example and fill these values.");
    process.exit(1);
  }

  requireConfirm();

  if (!process.env.DEPLOY_ENV) {
    process.env.DEPLOY_ENV = "production";
  }
  process.env.DRY_RUN = ""; // ensure real deploy

  console.log("[release-check:prod] Deploying to production (real deploy)");
  run("node scripts/deploy_prod.mjs");

  console.log("[release-check:prod] Post-deploy wiring check (prod)");
  run("node scripts/post_deploy_check.mjs");

  console.log("[release-check:prod] Running live prod smoke");
  run("node scripts/smoke_prod.mjs");

  console.log("✅ production release check complete");
}

main();
