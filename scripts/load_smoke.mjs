#!/usr/bin/env node

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const ADMIN_TOKEN = process.env.MASTER_ADMIN_TOKEN ?? process.env.ADMIN_TOKEN ?? "";
let apiKey = process.env.API_KEY ?? process.env.MEMORYNODE_API_KEY ?? "";

const SMALL_BURST = Number(process.env.LOAD_SMOKE_SMALL_BURST ?? "50");
const INGEST_BURST = Number(process.env.LOAD_SMOKE_INGEST_BURST ?? "10");
const PROBE_EXTRA = Number(process.env.LOAD_SMOKE_PROBE_EXTRA ?? "5");
const SMALL_ENDPOINT = (process.env.LOAD_SMOKE_SMALL_ENDPOINT ?? "search").toLowerCase(); // search | usage | health
const EXPECT_429 = (process.env.LOAD_SMOKE_EXPECT_429 ?? "1") !== "0";

function pct(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function callApi(method, path, { headers = {}, body } = {}) {
  const started = Date.now();
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const durationMs = Date.now() - started;

  let json = null;
  try {
    json = await response.clone().json();
  } catch {
    // non-json response
  }

  return {
    status: response.status,
    durationMs,
    json,
    requestId: response.headers.get("x-request-id") ?? "",
    retryAfter: response.headers.get("retry-after") ?? "",
    errorCode: json?.error?.code ?? "",
    ok: response.ok,
  };
}

async function createWorkspaceAndKey() {
  if (!ADMIN_TOKEN) {
    throw new Error("Missing API key and admin token. Set API_KEY or MASTER_ADMIN_TOKEN.");
  }

  const workspace = await callApi("POST", "/v1/workspaces", {
    headers: {
      "content-type": "application/json",
      "x-admin-token": ADMIN_TOKEN,
    },
    body: { name: `load-smoke-${Date.now()}` },
  });

  if (workspace.status !== 200) {
    throw new Error(`Failed to create workspace: status=${workspace.status} request_id=${workspace.requestId}`);
  }
  const workspaceId = workspace.json?.workspace_id;
  if (!workspaceId) {
    throw new Error(`Workspace bootstrap failed: status=${workspace.status} request_id=${workspace.requestId}`);
  }

  const keyRes = await callApi("POST", "/v1/api-keys", {
    headers: {
      "content-type": "application/json",
      "x-admin-token": ADMIN_TOKEN,
    },
    body: { workspace_id: workspaceId, name: "load-smoke-key" },
  });
  if (keyRes.status !== 200 || !keyRes.json?.api_key) {
    throw new Error(`API key bootstrap failed: status=${keyRes.status} request_id=${keyRes.requestId}`);
  }

  return keyRes.json.api_key;
}

function makeSmallRequest(i) {
  const authHeaders = apiKey
    ? {
        authorization: `Bearer ${apiKey}`,
      }
    : {};

  if (SMALL_ENDPOINT === "usage") {
    return callApi("GET", `/v1/usage/today?i=${i}`, { headers: authHeaders });
  }
  if (SMALL_ENDPOINT === "health") {
    return callApi("GET", `/healthz?i=${i}`);
  }
  return callApi("POST", "/v1/search", {
    headers: {
      "content-type": "application/json",
      ...authHeaders,
    },
    body: { user_id: "load-smoke-user", query: `hello-${i}`, top_k: 3 },
  });
}

function makeIngestRequest(i) {
  return callApi("POST", "/v1/memories", {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: { user_id: "load-smoke-user", text: `load smoke memory ${i}` },
  });
}

function summarize(results) {
  const latency = results.map((r) => r.durationMs);
  const statusCounts = new Map();
  for (const r of results) statusCounts.set(r.status, (statusCounts.get(r.status) ?? 0) + 1);

  const rateLimited = results.filter((r) => r.status === 429 || r.errorCode === "rate_limited");
  const success = results.filter((r) => r.status >= 200 && r.status < 300);
  const requestIds = [...new Set(results.map((r) => r.requestId).filter(Boolean))].slice(0, 8);

  console.log(`BASE_URL=${BASE_URL}`);
  console.log(`small_endpoint=${SMALL_ENDPOINT}`);
  console.log(`requests_total=${results.length}`);
  console.log(`success_count=${success.length}`);
  console.log(`rate_limited_count=${rateLimited.length}`);
  console.log(`latency_p50_ms=${pct(latency, 50)}`);
  console.log(`latency_p95_ms=${pct(latency, 95)}`);
  console.log(`status_counts=${JSON.stringify(Object.fromEntries(statusCounts.entries()))}`);
  console.log(`request_id_samples=${JSON.stringify(requestIds)}`);

  const retryAfterValues = rateLimited.map((r) => Number(r.retryAfter || "0")).filter((n) => Number.isFinite(n));
  if (retryAfterValues.length > 0) {
    console.log(`retry_after_samples=${JSON.stringify(retryAfterValues.slice(0, 8))}`);
  }

  return { rateLimitedCount: rateLimited.length };
}

async function main() {
  if (!apiKey) {
    apiKey = await createWorkspaceAndKey();
    console.log("Created temporary workspace + API key for load smoke.");
  }

  const smallBurst = await Promise.all(Array.from({ length: SMALL_BURST }, (_, i) => makeSmallRequest(i)));
  const ingestBurst = await Promise.all(Array.from({ length: INGEST_BURST }, (_, i) => makeIngestRequest(i)));

  const probe = await Promise.all(
    Array.from({ length: PROBE_EXTRA }, (_, i) =>
      callApi("GET", `/v1/usage/today?probe=${i}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    ),
  );

  const all = [...smallBurst, ...ingestBurst, ...probe];
  const summary = summarize(all);

  if (EXPECT_429 && summary.rateLimitedCount === 0) {
    console.error(
      "Expected at least one 429/rate_limited response but saw none. This may indicate limiter misconfiguration or too-high thresholds.",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`load_smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
