#!/usr/bin/env node
/**
 * Beta verification helper.
 * Inputs:
 *   BASE_URL, API_KEY, USER_ID, NAMESPACE
 */

const BASE_URL = (process.env.BASE_URL ?? "").trim();
const API_KEY = (process.env.API_KEY ?? "").trim();
const USER_ID = (process.env.USER_ID ?? "").trim();
const NAMESPACE = (process.env.NAMESPACE ?? "").trim();
const TIMEOUT_MS = Number(process.env.BETA_VERIFY_TIMEOUT_MS ?? "15000");

function fail(message) {
  console.error(`[beta:verify] ${message}`);
  process.exit(1);
}

if (!BASE_URL) fail("Missing BASE_URL");
if (!API_KEY) fail("Missing API_KEY");
if (!USER_ID) fail("Missing USER_ID");
if (!NAMESPACE) fail("Missing NAMESPACE");

function extractRequestId(res, body) {
  return (
    res.headers.get("x-request-id") ??
    (body && typeof body.request_id === "string" ? body.request_id : null) ??
    res.headers.get("cf-ray") ??
    "<not-exposed>"
  );
}

async function request(method, path, { body, auth = true } = {}) {
  const res = await fetch(new URL(path, BASE_URL), {
    method,
    headers: {
      ...(auth ? { Authorization: `Bearer ${API_KEY}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const raw = await res.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    // ignore non-json
  }
  const requestId = extractRequestId(res, json);
  return { res, json, raw, requestId };
}

function assertOk(step, outcome) {
  if (outcome.res.ok) return;
  const code = outcome.json?.error?.code ?? "UNKNOWN";
  const message = outcome.json?.error?.message ?? outcome.raw ?? "<empty>";
  fail(`${step} failed status=${outcome.res.status} request_id=${outcome.requestId} code=${code} message=${message}`);
}

function printStep(name, outcome, extra = {}) {
  console.log(
    JSON.stringify(
      {
        step: name,
        status: outcome.res.status,
        request_id: outcome.requestId,
        ...extra,
      },
      null,
      2,
    ),
  );
}

async function main() {
  console.log("[beta:verify] starting");
  console.log(`[beta:verify] base_url=${BASE_URL}`);
  console.log(`[beta:verify] user_id=${USER_ID} namespace=${NAMESPACE}`);

  const health = await request("GET", "/healthz", { auth: false });
  assertOk("healthz", health);
  printStep("healthz", health, { body: health.json });

  const usage = await request("GET", "/v1/usage/today");
  assertOk("usage_today", usage);
  printStep("usage_today", usage, { body: usage.json });

  const text = `beta verify memory ${new Date().toISOString()}`;
  const ingest = await request("POST", "/v1/memories", {
    body: { user_id: USER_ID, namespace: NAMESPACE, text, metadata: { source: "beta_verify" } },
  });
  assertOk("ingest", ingest);
  printStep("ingest", ingest, { memory_id: ingest.json?.memory_id ?? null });

  const search = await request("POST", "/v1/search", {
    body: { user_id: USER_ID, namespace: NAMESPACE, query: "beta verify memory", top_k: 5 },
  });
  assertOk("search", search);
  const searchHits = Array.isArray(search.json?.results) ? search.json.results.length : 0;
  printStep("search", search, { hits: searchHits });
  if (searchHits < 1) fail(`search returned no hits request_id=${search.requestId}`);

  const context = await request("POST", "/v1/context", {
    body: {
      user_id: USER_ID,
      namespace: NAMESPACE,
      query: "Summarize the beta verify memory.",
      top_k: 5,
    },
  });
  assertOk("context", context);
  const contextText = typeof context.json?.context_text === "string" ? context.json.context_text : "";
  printStep("context", context, {
    context_chars: contextText.length,
    citations: Array.isArray(context.json?.citations) ? context.json.citations.length : 0,
  });
  if (!contextText.trim()) fail(`context_text was empty request_id=${context.requestId}`);

  console.log("[beta:verify] PASS");
}

main().catch((err) => fail(`unexpected error: ${err?.message ?? String(err)}`));
