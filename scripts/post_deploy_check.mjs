#!/usr/bin/env node
/**
 * Post-deploy wiring check: health, Supabase-backed call, rate-limit path.
 */

import fs from "node:fs";

function loadEnvFile(path) {
  if (!fs.existsSync(path)) return;
  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [k, ...rest] = line.split("=");
    const v = rest.join("=");
    if (k && v && !(k in process.env)) {
      process.env[k.trim()] = v.trim();
    }
  }
  console.log(`[post-check] loaded ${path}`);
}

function requireEnv(names) {
  for (const n of names) {
    const val = process.env[n];
    if (val && String(val).trim() !== "") return val.trim();
  }
  throw new Error(`Missing required env var (provide one of): ${names.join(", ")}`);
}

async function req(baseUrl, path, init = {}) {
  const url = new URL(path, baseUrl).toString();
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore parse errors */
  }
  return { res, text, json };
}

async function main() {
  loadEnvFile(".env.prod.smoke");
  loadEnvFile(".env.staging.smoke");
  loadEnvFile(".env.gate");

  const baseUrl = requireEnv(["PROD_BASE_URL", "STAGING_BASE_URL", "BASE_URL"]);
  const apiKey = requireEnv(["PROD_API_KEY", "STAGING_API_KEY", "MEMORYNODE_API_KEY"]);
  const headers = { authorization: `Bearer ${apiKey}` };

  console.log("[post-check] GET /healthz");
  const h = await req(baseUrl, "/healthz");
  if (!h.res.ok || h.json?.status !== "ok") {
    throw new Error(`/healthz failed or status!=ok (status ${h.res.status}) body=${h.text.slice(0, 200)}`);
  }

  console.log("[post-check] GET /v1/usage/today");
  const u = await req(baseUrl, "/v1/usage/today", { headers });
  if (!u.res.ok) throw new Error(`/v1/usage/today failed status ${u.res.status}`);

  console.log("[post-check] rate-limit probe (two quick requests to /v1/usage/today)");
  const r1 = await req(baseUrl, "/v1/usage/today", { headers });
  const r2 = await req(baseUrl, "/v1/usage/today", { headers });
  if (!r1.res.ok || !r2.res.ok) {
    throw new Error(`Rate-limit probe failed status1=${r1.res.status} status2=${r2.res.status}`);
  }

  console.log("✅ post-deploy wiring check passed");
}

main().catch((err) => {
  console.error("❌ post-deploy wiring check failed:", err.message);
  process.exit(1);
});
