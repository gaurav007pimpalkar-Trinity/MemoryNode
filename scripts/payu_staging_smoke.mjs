#!/usr/bin/env node
/**
 * PayU staging smoke test.
 *
 * Required env:
 * - BASE_URL: full base URL of the deployed API
 * - PAYU_MERCHANT_KEY: PayU merchant key (presence check)
 * - PAYU_MERCHANT_SALT: PayU merchant salt (presence check)
 * - MEMORYNODE_API_KEY: API key for auth
 *
 * This script validates:
 *  - GET  /v1/billing/status
 *  - POST /v1/billing/checkout (expects PayU payload)
 *  - POST /v1/billing/portal (expects 410 GONE)
 */

const { BASE_URL, PAYU_MERCHANT_KEY, PAYU_MERCHANT_SALT, MEMORYNODE_API_KEY } = process.env;
const REQUEST_ID_PREFIX = (process.env.PAYU_SMOKE_REQUEST_ID_PREFIX ?? "payu-staging").trim() || "payu-staging";

function requireEnv(name) {
  if (!process.env[name] || `${process.env[name]}`.trim() === "") {
    throw new Error(`Missing required env: ${name}`);
  }
}

async function request(method, path, body, stepName) {
  const requestId = `${REQUEST_ID_PREFIX}-${stepName}-${Date.now().toString(36)}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${MEMORYNODE_API_KEY}`,
      "x-request-id": requestId,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }
  return { status: res.status, ok: res.ok, text, json, requestId: res.headers.get("x-request-id") ?? requestId };
}

async function main() {
  requireEnv("BASE_URL");
  requireEnv("PAYU_MERCHANT_KEY");
  requireEnv("PAYU_MERCHANT_SALT");
  requireEnv("MEMORYNODE_API_KEY");

  let pass = true;

  const status = await request("GET", "/v1/billing/status", undefined, "status");
  const statusOk = status.ok && status.json && typeof status.json.plan === "string";
  console.log(`[${statusOk ? "PASS" : "FAIL"}] status request_id=${status.requestId} status=${status.status}`);
  pass &&= Boolean(statusOk);

  const checkout = await request("POST", "/v1/billing/checkout", {}, "checkout");
  const checkoutOk =
    checkout.ok &&
    checkout.json?.provider === "payu" &&
    checkout.json?.method === "POST" &&
    typeof checkout.json?.url === "string" &&
    typeof checkout.json?.fields?.hash === "string";
  console.log(`[${checkoutOk ? "PASS" : "FAIL"}] checkout request_id=${checkout.requestId} status=${checkout.status}`);
  pass &&= Boolean(checkoutOk);

  const portal = await request("POST", "/v1/billing/portal", {}, "portal");
  const portalOk = portal.status === 410 && portal.json?.error?.code === "GONE";
  console.log(`[${portalOk ? "PASS" : "FAIL"}] portal_gone request_id=${portal.requestId} status=${portal.status}`);
  pass &&= Boolean(portalOk);

  console.log(`PayU staging smoke: ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
