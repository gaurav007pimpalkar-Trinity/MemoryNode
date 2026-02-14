# MemoryNode Observability

Production observability guide: golden metrics, structured events, and a single health checklist.

---

## 1) Golden Metrics

Every metric below is emitted as a structured JSON log line. No additional agents or exporters are required — consume via Cloudflare Logpush → your log sink (R2, Datadog, Grafana Cloud, etc.).

### 1a) Request Rate / Error Rate / Latency

| Field | Source event | Description |
| --- | --- | --- |
| Request rate | `event_name="request_completed"` | Count per `route_group`, `method`. |
| Error rate (4xx) | `request_completed` with `status` 400–499 | Client errors — auth failures (401/403), validation (400), cap exceeded (402), rate-limited (429). |
| Error rate (5xx) | `request_completed` with `status>=500` | Server errors — DB failures, config errors, internal bugs. |
| Latency p50/p95/p99 | `request_completed.duration_ms` (alias `latency_ms`) | Per-request wall-clock latency. Bucket by `route_group`. |

**Route groups** (emitted as `route_group` on every `request_completed`):

`health`, `memories`, `search`, `context`, `usage`, `billing`, `workspaces`, `api_keys`, `export`, `import`, `admin`, `unknown`.

### 1b) Quota & Rate-Limit Rejections

| Field | Source event | Description |
| --- | --- | --- |
| Cap exceeded (402) | `event_name="cap_exceeded"` | Daily plan limits hit. Carries `workspace_id_redacted`, `effective_plan`, `plan_status`. |
| Rate limited (429) | `request_completed` with `error_code="rate_limited"` | Per-key rate limit exceeded. |
| Top rejecting keys | Group `cap_exceeded` / `rate_limited` by `workspace_id_redacted` | Identify noisiest consumers. |

### 1c) Search Latency & Embed Latency

| Field | Source event | Description |
| --- | --- | --- |
| Embed latency | `event_name="embed_request"` → `embed_latency_ms` | OpenAI embedding API round-trip. Includes `embed_count`, `status`, `success`. |
| Search latency | `event_name="search_request"` → `search_latency_ms` | End-to-end search (embed + vector + text match + fusion). Includes `result_count`. |

### 1d) PayU Webhook Pipeline

| Field | Source event | Description |
| --- | --- | --- |
| Webhook received | `event_name="webhook_received"` | Inbound PayU callback. |
| Webhook verified | `event_name="webhook_verified"` | Hash verification passed. |
| Webhook processed | `event_name="webhook_processed"` | Side-effects applied successfully. |
| Webhook replayed | `event_name="webhook_replayed"` | Duplicate `event_id` safely ignored. |
| Webhook deferred | `event_name="webhook_deferred"` | Workspace mapping missing; parked for retry. Track queue depth as count of deferred events. |
| Webhook reconciled | `event_name="webhook_reconciled"` | PayU verify API resolved ambiguous ordering. |
| Webhook failed | `event_name="webhook_failed"` | Verification or processing threw. |
| Signature invalid | `event_name="billing_webhook_signature_invalid"` | PayU hash validation failed. |
| Workspace not found | `event_name="billing_webhook_workspace_not_found"` | Webhook customer cannot be mapped to a workspace. |
| Billing endpoint error | `event_name="billing_endpoint_error"` | Status/checkout/portal handlers failed. |

**Reconcile backlog / deferred queue depth**: count of `webhook_deferred` minus `webhook_reconciled` events within your rolling window.

### 1e) DB Latency & RPC Failures

| Field | Source event | Description |
| --- | --- | --- |
| DB RPC latency | `event_name="db_rpc"` → `db_latency_ms` | Per-call latency for Supabase RPCs (`match_chunks_vector`, `match_chunks_text`). Includes `rpc`, `result_count`, `success`. |
| DB failures | `request_completed.error_code="DB_ERROR"` | Any Supabase RPC or query failure surfaced to the caller. |

---

## 2) Structured Event Catalog

All events emitted as structured JSON via `console.log` / `console.error`:

| Event name | Level | Key fields |
| --- | --- | --- |
| `request_completed` | info | `workspace_id`, `route`, `route_group`, `method`, `status`, `duration_ms`, `latency_ms`, `request_id`, `error_code?`, `error_message?` |
| `request_failed` | error | `request_id`, `route`, `method`, `status`, `error_code`, `error_message`, `workspace_id` |
| `cap_exceeded` | info | `route`, `method`, `status=402`, `request_id`, `workspace_id_redacted`, `effective_plan`, `plan_status` |
| `embed_request` | info/error | `embed_latency_ms`, `embed_count`, `status`, `success` |
| `search_request` | info | `search_latency_ms`, `result_count`, `page`, `page_size` |
| `db_rpc` | info/error | `rpc`, `db_latency_ms`, `result_count`, `success` |
| `audit_log` | info | `request_id`, `audit.*` (route, method, status, latency_ms, bytes_in, bytes_out, ip_hash, workspace_id, api_key_id) |
| `webhook_received` | info | `route`, `method`, `request_id`, `provider` |
| `webhook_verified` | info | `request_id`, `payu_event_id`, `event_type`, `event_created`, `provider` |
| `webhook_processed` | info | `request_id`, `payu_event_id`, `event_type`, `outcome`, `workspace_id` |
| `webhook_replayed` | info | `request_id`, `payu_event_id`, `event_type`, `replay_status` |
| `webhook_deferred` | info | `request_id`, `payu_event_id`, `event_type`, `reason`, `txn_id_redacted` |
| `webhook_reconciled` | info | `request_id`, reconciliation context |
| `webhook_failed` | error | `request_id`, `payu_event_id`, `event_type`, `error` |
| `billing_webhook_signature_invalid` | info | `request_id`, `route`, `status=400` |
| `billing_webhook_workspace_not_found` | info | `request_id`, `route` |
| `billing_endpoint_error` | error | `request_id`, `route`, `error` |

---

## 3) "Is the API Healthy?" — 60-Second Checklist

Run through this checklist to assess production health in under 60 seconds.

### Quick-check commands

```bash
# 1. Healthz endpoint (should return {"status":"ok",...})
curl -s https://api.memorynode.ai/healthz | jq .

# 2. Check x-request-id header is present
curl -sI https://api.memorynode.ai/healthz | grep -i x-request-id
```

### Single health view (Cloudflare Logs or your SIEM)

| # | Check | Log filter | Healthy when |
| --- | --- | --- | --- |
| 1 | API responding | `event_name="request_completed"` | Events flowing in last 5 min |
| 2 | No 5xx spike | `event_name="request_completed" AND status>=500` | <1% of requests over 5 min |
| 3 | Auth working | `event_name="request_completed" AND (status=401 OR status=403)` | <20% over 10 min |
| 4 | Latency OK | `event_name="request_completed"` → `duration_ms` | p95 < 500ms, p99 < 1500ms |
| 5 | Rate limits normal | `event_name="cap_exceeded"` OR `error_code="rate_limited"` | <50 events in 5 min |
| 6 | Embeds fast | `event_name="embed_request"` → `embed_latency_ms` | p95 < 2000ms |
| 7 | Search fast | `event_name="search_request"` → `search_latency_ms` | p95 < 3000ms |
| 8 | DB healthy | `event_name="db_rpc"` → `db_latency_ms` | p95 < 500ms, no `success=false` burst |
| 9 | Webhooks flowing | `event_name="webhook_processed"` | Processing after each PayU callback |
| 10 | No webhook backlog | `event_name="webhook_deferred"` | <5 deferred in last hour |
| 11 | No signature issues | `event_name="billing_webhook_signature_invalid"` | 0 in last hour |

**If any check is RED**: see `docs/ALERTS.md` for triage mapping.

---

## 4) SLO Definitions (Appendix A — Explicit Math)

All SLOs use a **28-day rolling** window unless otherwise stated. Status page and internal dashboards use these definitions.

| SLO | Definition (exact) |
| --- | --- |
| **Availability** | `1 - (5xx_count / total_requests)` over the **28-day rolling** window. **Exclude** 4xx client errors from both numerator and denominator (i.e. availability = server success rate). **429 (rate-limited) is treated as 4xx** and excluded from this SLO. Add **"429 rate per tenant"** as a separate operational KPI with alerts (see ALERTS.md B2, B3). |
| **Latency p99** | **p99** of `duration_ms` (or `latency_ms`) for **successful** requests (HTTP 2xx, optionally 3xx) **per route_group**. Failed requests (4xx/5xx) excluded from latency SLO. **Health view only:** Track **p99 latency for 5xx** ("time to fail") separately — not an SLO but in health dashboard. |
| **Webhook processing within 5 min** | **p99** of (processed_timestamp − verify_timestamp) for webhooks that reached "verified" state. **Exclude** webhooks that failed signature verification. Unit: seconds; threshold 300 s (5 min). |

**Error budget:** When budget is exhausted, we freeze non-essential releases and prioritize reliability. See `docs/INCIDENT_PROCESS.md` § Error Budget Policy.

**Staged publishing (CEO guardrail):** Don't publish aggressive numbers before measured baseline. Month 1: availability SLO only. Month 2+: add latency once baseline exists.

### 4.1 SLO Targets (Staged)

| SLO | Internal target (example) | Public (when baseline supports) | Measured from |
| --- | --- | --- | --- |
| API availability | 99.9% (excl. 4xx) | Start with 99.5%; raise after history | `request_completed` status < 500; 28-day rolling |
| API latency p99 | < 2000 ms | Add in Month 2+ once tuned | `request_completed.duration_ms` |
| 5xx error rate | < 0.1% | Tie to availability | `request_completed` |
| Webhook processing | 99% within 5 min | After baseline | webhook_verified → webhook_processed |
| Deferred queue | Alert if depth > N | — | webhook_deferred − webhook_reconciled |

---

## 5) How to Consume Logs

1. **Cloudflare Logpush**: Forward Worker logs to R2, S3, Datadog, Splunk, or Grafana Cloud Logs.
2. **Cloudflare Dashboard**: Workers & Pages → API Worker → Logs → filter by `event_name`.
3. **Build dashboards** from the JSON fields above; do not parse bodies or headers.
4. **Trace a single request**: filter by `request_id="<value from x-request-id response header>"`.
5. **Billing incidents**: filter for `event_name in ("webhook_received","webhook_verified","webhook_processed","webhook_replayed","webhook_failed")`.

**Saved queries:** Every signal in §3.1 is defined in `docs/observability/saved_queries.md`. Health view: `docs/HEALTH_VIEW.md`.

---

## 6) Client Behavior for 429/413

- `429` responses use `error.code="rate_limited"` and include `Retry-After` plus `x-request-id`.
- `413` responses use `error.code="payload_too_large"` and include `x-request-id`.
- Retry guidance:
  - On `429`: respect `Retry-After`, then exponential backoff with jitter (`250ms`, `500ms`, `1s`, `2s`, …).
  - On `413`: do not retry unchanged payloads; split/chunk and retry with smaller bodies.
  - Always log `request_id` with UTC timestamp so incidents can be traced from Cloudflare logs.
