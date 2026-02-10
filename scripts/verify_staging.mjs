#!/usr/bin/env node
/**
 * One-command staging verification.
 * Requires:
 *   BASE_URL=https://<deployed-worker>
 *   ADMIN_TOKEN=<MASTER_ADMIN_TOKEN>
 *
 * Flow:
 *   1) GET /healthz
 *   2) POST /v1/workspaces (admin)
 *   3) POST /v1/api-keys (admin)
 *   4) GET /v1/usage/today (api key auth)
 */

const BASE_URL = (process.env.BASE_URL ?? "").trim();
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN ?? process.env.MASTER_ADMIN_TOKEN ?? "").trim();
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS ?? "15000");

if (!BASE_URL) {
  console.error("Missing BASE_URL. Example: BASE_URL=https://api-staging.example.com");
  process.exit(1);
}
if (!ADMIN_TOKEN) {
  console.error("Missing ADMIN_TOKEN (or MASTER_ADMIN_TOKEN).");
  process.exit(1);
}

function mask(value) {
  if (!value) return "<empty>";
  if (value.length <= 8) return `${value[0]}***${value[value.length - 1]}`;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function requestJson(method, path, { headers = {}, body } = {}) {
  const url = new URL(path, BASE_URL).toString();
  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text for diagnostics
  }
  return { response, text, json };
}

function fail(step, outcome, extra = "") {
  const code = outcome?.json?.error?.code ?? "<none>";
  const message = outcome?.json?.error?.message ?? "<none>";
  const body = outcome?.text?.slice(0, 400) ?? "";
  console.error(`\n[staging:verify] ${step} failed`);
  if (outcome?.response) {
    console.error(`status=${outcome.response.status} error_code=${code} error_message=${message}`);
  }
  if (extra) console.error(extra);
  if (body) console.error(`body=${body}`);
  process.exit(1);
}

async function main() {
  console.log(`[staging:verify] BASE_URL=${BASE_URL}`);
  console.log(`[staging:verify] ADMIN_TOKEN=${mask(ADMIN_TOKEN)}`);

  console.log("[staging:verify] 1/4 GET /healthz");
  const health = await requestJson("GET", "/healthz");
  if (!health.response.ok || health.json?.status !== "ok") {
    fail("GET /healthz", health);
  }

  console.log("[staging:verify] 2/4 POST /v1/workspaces");
  const workspaceName = `staging-verify-${Date.now()}`;
  const workspace = await requestJson("POST", "/v1/workspaces", {
    headers: { "x-admin-token": ADMIN_TOKEN },
    body: { name: workspaceName },
  });
  if (!workspace.response.ok || !workspace.json?.workspace_id) {
    fail("POST /v1/workspaces", workspace, "Expected workspace_id in response.");
  }
  const workspaceId = workspace.json.workspace_id;

  console.log("[staging:verify] 3/4 POST /v1/api-keys");
  const keyResp = await requestJson("POST", "/v1/api-keys", {
    headers: { "x-admin-token": ADMIN_TOKEN },
    body: { workspace_id: workspaceId, name: "staging-verify-key" },
  });
  if (!keyResp.response.ok || !keyResp.json?.api_key) {
    fail("POST /v1/api-keys", keyResp, "Expected api_key in response.");
  }
  const apiKey = keyResp.json.api_key;

  console.log("[staging:verify] 4/4 GET /v1/usage/today");
  const usage = await requestJson("GET", "/v1/usage/today", {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!usage.response.ok) {
    fail("GET /v1/usage/today", usage);
  }

  console.log("[staging:verify] PASS");
  console.log(`[staging:verify] workspace_id=${workspaceId}`);
  console.log(`[staging:verify] api_key=${mask(apiKey)} (plaintext shown once by API; keep it secure)`);
}

main().catch((err) => {
  console.error(`[staging:verify] unexpected failure: ${err?.message ?? String(err)}`);
  process.exit(1);
});
