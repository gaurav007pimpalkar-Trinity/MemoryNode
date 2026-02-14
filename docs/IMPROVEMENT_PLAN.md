# MemoryNode: Plan to Fix All Wrongs and Implement All Improvements

This plan maps every **wrong** to a fix and every **improvement** to concrete tasks, in dependency order. Each phase ends with a short checklist so you can track progress.

---

## Overview

| Phase | Focus | Wrongs addressed | Improvements |
|-------|--------|-------------------|---------------|
| 1 | Docs & config | #1 (Stripe vs PayU), #9 (secret-scan) | Inv 1, Smart 11 (runbook + CI) |
| 2 | Single Env & API behavior | #2 (Env drift), #5 (no 405) | Inv 2, Inv 3 |
| 3 | Dashboard UX | #6 (typo done; Load more, error boundary) | Smart 9 |
| 4 | Worker split | #3 (giant file) | Smart 7 |
| 5 | Validation & contract | #4 (no contract) | Inv 4, Smart 8 |
| 6 | Observability & security | #10 (no metrics), #9 | Inv 5, Inv 6 |
| 7 | Tests & DX | #7, #8 (any, Stripe mock) | Smart 10, Smart 11 (CI), Smart 12 |

**Already done:** Dashboard encoding typo (`Loadingâ€¦` → `Loading…`).

---

## Phase 1: Documentation and config (fix wrongs #1, #9; implement Inv 1, Smart 11)

**Goal:** PayU is the single source of truth in docs; runbooks and checklists match code; CI catches doc drift.

### 1.1 Replace Stripe with PayU in all docs

| Task | File(s) | Action |
|------|---------|--------|
| 1.1.1 | `docs/QUICKSTART.md` | Remove Stripe keys from “Minimum required”; add PayU vars only where billing is needed; add one line: “Billing uses PayU; see docs/BILLING_RUNBOOK.md.” |
| 1.1.2 | `docs/PROD_SETUP_CHECKLIST.md` | Replace entire “Stripe (production) setup” section with “PayU (production) setup”: PAYU_MERCHANT_KEY, PAYU_MERCHANT_SALT, PAYU_VERIFY_URL, PAYU_WEBHOOK_SECRET (if used), PUBLIC_APP_URL, PAYU_SUCCESS_PATH, PAYU_CANCEL_PATH. Remove STRIPE_* checklist items and wrangler secret commands for Stripe. |
| 1.1.3 | `docs/RELEASE_RUNBOOK.md` | In “Required runtime config”, replace STRIPE_* vars with PayU vars; in “Secrets”, replace Stripe secrets with PayU; update “Access” to say “PayU” instead of “Stripe”. |
| 1.1.4 | `docs/BILLING_RUNBOOK.md` | Rewrite for PayU: signature/hash verification, verify API, idempotency via payu_webhook_events, replay/reprocess, reconciliation. Remove Stripe SDK and Stripe CLI examples; add PayU equivalents where applicable. |
| 1.1.5 | `docs/OPERATIONS.md` | Replace Stripe secret rows with PayU (PAYU_MERCHANT_KEY, PAYU_MERCHANT_SALT, PAYU_WEBHOOK_SECRET if used). Update “Stripe webhook failures” to “PayU webhook failures” and point to BILLING_RUNBOOK. |
| 1.1.6 | `docs/ALERTS.md` | Replace “Stripe webhook failures” with “PayU webhook failures”; keep same event names/codes that exist in code (e.g. webhook_failed, billing_webhook_signature_invalid). Update “Stripe failures” mitigation to “PayU” (verify hash, replay). |
| 1.1.7 | `docs/OBSERVABILITY.md` | Replace “Stripe” with “PayU” in webhook_received / webhook_reconciled / billing_webhook_signature_invalid descriptions. |
| 1.1.8 | `docs/API_REFERENCE.md` | Billing section: “POST /v1/billing/checkout” returns PayU hosted checkout (URL or POST form); “POST /v1/billing/portal” → 410 Gone; “POST /v1/billing/webhook” → PayU callback (raw body, hash verified). |
| 1.1.9 | `docs/TROUBLESHOOTING_BETA.md` | Replace “Stripe webhook failures” row with “PayU webhook failures”; validation steps for PayU (hash, workspace, verify API). |
| 1.1.10 | `docs/SECURITY.md` | Replace “Stripe” subsection with “PayU”: PAYU_MERCHANT_KEY, PAYU_MERCHANT_SALT, PAYU_WEBHOOK_SECRET (if used); rotation and storage. |
| 1.1.11 | `docs/PRODUCTION_DEPLOY.md` | Safe vars: remove STRIPE_*; add PayU vars that are safe (e.g. PAYU_BASE_URL, PAYU_VERIFY_URL, PUBLIC_APP_URL, PAYU_SUCCESS_PATH, PAYU_CANCEL_PATH). Secrets: remove Stripe; add PAYU_MERCHANT_KEY, PAYU_MERCHANT_SALT. |
| 1.1.12 | `docs/PRE_PUSH_CHECKLIST.md` | Replace “STRIPE secrets” with “PayU secrets” in release:gate description. |
| 1.1.13 | `apps/dashboard/README.md` | Already says 410 for portal; ensure billing sentence says “PayU” not “Stripe”. |

### 1.2 Billing section in main README

| Task | File | Action |
|------|------|--------|
| 1.2.1 | `docs/README.md` | Add a short “Billing (PayU)” bullet: “Production billing is PayU-only. See docs/BILLING_RUNBOOK.md for webhook ops and docs/PROD_SETUP_CHECKLIST.md for PayU setup.” |

### 1.3 CI: doc vs code check

| Task | File | Action |
|------|------|--------|
| 1.3.1 | `scripts/check_docs_billing.mjs` (new) | Script that: (a) greps docs for “STRIPE_SECRET_KEY” or “STRIPE_WEBHOOK_SECRET” in “required” or “production” context; (b) if found, exits 1 with “Docs still require Stripe; billing is PayU. Update PROD_SETUP_CHECKLIST and RELEASE_RUNBOOK.” (c) **CI must fail** if Stripe env var names or “Stripe” as required billing provider appear in billing-related docs (PROD_SETUP_CHECKLIST, RELEASE_RUNBOOK, BILLING_RUNBOOK, QUICKSTART billing section). Allow Stripe only in a clearly marked “Historical notes” or “Future: Stripe” section if you keep one. |
| 1.3.2 | `package.json` | Add script: `"check:docs-billing": "node scripts/check_docs_billing.mjs"`. |
| 1.3.3 | `.github/workflows/ci.yml` | In build job, add step: “Check docs billing (PayU)” running `pnpm check:docs-billing`. |

### Phase 1 done when (doc-check acceptance criteria)

- [ ] **No Stripe env var names** appear in docs except in a clearly marked historical/future section (e.g. “Historical: Stripe” or “If we add Stripe later”).
- [ ] **PayU env var names** appear in QUICKSTART (for billing) and in PROD_SETUP_CHECKLIST / RELEASE_RUNBOOK as the production billing setup.
- [ ] **CI fails** if Stripe terms (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, or “Stripe” as required) appear in billing docs (PROD_SETUP_CHECKLIST, RELEASE_RUNBOOK, BILLING_RUNBOOK, QUICKSTART).
- [ ] BILLING_RUNBOOK, ALERTS, OBSERVABILITY, TROUBLESHOOTING_BETA, PRODUCTION_DEPLOY, PRE_PUSH, dashboard README use PayU.
- [ ] docs/README.md has “Billing (PayU)” pointer.
- [ ] CI runs `check:docs-billing` and passes.

---

## Phase 2: Single Env and 405 (fix wrongs #2, #5; implement Inv 2, Inv 3)

**Goal:** One `Env` type used everywhere; known paths return 405 for disallowed methods.

### 2.1 Single Env source of truth

| Task | File | Action |
|------|------|--------|
| 2.1.1 | `apps/api/src/env.ts` | Add to `Env`: `RATE_LIMIT_DO: DurableObjectNamespace`, and any other vars only in index.ts today (e.g. MAX_BODY_BYTES, MAX_IMPORT_BYTES, MAX_EXPORT_BYTES, BUILD_VERSION, GIT_SHA). Import `DurableObjectNamespace` from `@cloudflare/workers-types`. Ensure PayU and RATE_LIMIT_* are present. |
| 2.1.2 | `apps/api/src/index.ts` | Remove the local `interface Env` block. Add at top: `import type { Env } from "./env.js";` (or re-export Env from a barrel if you prefer). Fix any type errors. |
| 2.1.3 | `apps/api/tests/*.ts` | Where tests construct env objects, use `Env` from `env.ts` or a `Partial<Env>` / `MockEnv` type so required bindings are explicit. |

### 2.2 405 Method Not Allowed

**Definition of “known path” (must all return 405 with correct `Allow` when method is disallowed):**

| Path / pattern | Allowed methods |
|----------------|-----------------|
| `/healthz` | GET |
| `/v1/memories` | GET, POST |
| `/v1/memories/:id` | GET, DELETE |
| `/v1/search` | POST |
| `/v1/context` | POST |
| `/v1/usage/today` | GET |
| `/v1/billing/status` | GET |
| `/v1/billing/checkout` | POST |
| `/v1/billing/portal` | POST |
| `/v1/billing/webhook` | POST |
| `/v1/workspaces` | POST |
| `/v1/api-keys` | GET, POST |
| `/v1/api-keys/revoke` | POST |
| `/v1/export` | POST |
| `/v1/import` | POST |
| `/v1/admin/billing/health` | GET |
| `/admin/webhooks/reprocess` | POST |

Implement 405 for **every** row above so there is no partial implementation (e.g. don’t ship with only half the routes returning 405).

| Task | File | Action |
|------|------|--------|
| 2.2.1 | `apps/api/src/index.ts` (or later `router.ts`) | Define a single map/table: path pattern → allowed methods using the table above. Before returning 404, check if path matches a known pattern; if yes and method not in list, return 405 with `Allow: <comma-separated list>` and body `{ error: { code: "METHOD_NOT_ALLOWED", message: "..." } }`. |
| 2.2.2 | Tests | Add tests so each known path returns 405 with correct `Allow` for at least one disallowed method (e.g. POST /healthz, GET /v1/search, PATCH /v1/memories/xyz). |

### Phase 2 done when

- [ ] `Env` is defined only in `env.ts` and used in `index.ts` and tests.
- [ ] **Every** path in the “Definition of known path” table above returns 405 with correct `Allow` when method is disallowed (no partial implementation).
- [ ] 404 only for unknown paths.
- [ ] CI (lint, typecheck, test) passes.

---

## Phase 3: Dashboard UX (fix wrong #6 remainder; implement Smart 9)

**Goal:** Load more uses API pagination; simple error boundary and retry/back.

### 3.1 Search: total / has_more and Load more

| Task | File | Action |
|------|------|--------|
| 3.1.1 | `apps/dashboard/src/App.tsx` | In MemoryView, call search API and store `total` and `has_more` from response. Disable “Load more” when `!has_more` or when `results.length >= total`. Optionally show “X of Y results” or “No more results.” |

### 3.2 Error boundary and retry

| Task | File | Action |
|------|------|--------|
| 3.2.1 | `apps/dashboard/src/App.tsx` or `ErrorBoundary.tsx` (new) | Add a React error boundary around the main app content (below auth/shell). On error, render a simple panel: “Something went wrong” + “Retry” button (reset error state and re-render) and “Back” (e.g. clear selection or go to first tab). |
| 3.2.2 | Optional | For API errors in MemoryView/UsageView, show “Retry” next to the error message where you already have retry logic. |

### Phase 3 done when

- [ ] Load more disabled when no more results; total/has_more from API used.
- [ ] Error boundary catches render errors; Retry/Back work.
- [ ] No new regressions; dashboard builds and runs.

---

## Phase 4: Split Worker into modules (fix wrong #3; implement Smart 7)

**Goal:** `index.ts` is a thin fetch handler; routing and handlers live in separate modules.

**Refactor invariant: no external API behavior change.** The split is internal only. Before considering Phase 4 done, confirm:

- **Same routes** – Every path and method that works today still works; no routes removed or renamed.
- **Same status codes** – 200, 201, 204, 400, 401, 402, 403, 404, 405, 410, 413, 429, 500 unchanged for the same inputs.
- **Same JSON shapes** – Request and response bodies (including error `{ error: { code, message } }`) unchanged.
- **Same headers** – CORS headers, `x-request-id`, and any other response headers unchanged.
- **Same auth and quota semantics** – API key and admin token behavior unchanged; rate limiting and cap enforcement unchanged.

If any of the above change, treat it as a bug and fix before merging the split.

### 4.1 Create handler modules and router

| Task | File | Action |
|------|------|--------|
| 4.1.1 | `apps/api/src/router.ts` | New file. Export a single function `route(request, env, url): Promise<Response | null>`. Implement path+method matching (same order as today); for each match call the corresponding handler (imported from handlers/*). Return null for “not found” so index can return 404 or 405. Move 405 logic here (path → allowed methods). |
| 4.1.2 | `apps/api/src/handlers/memories.ts` | New file. Export `handleCreateMemory`, `handleListMemories`, `handleGetMemory`, `handleDeleteMemory`. Move the corresponding functions and their direct helpers from index.ts. Import Env, SupabaseClient, logger, etc. from appropriate places. |
| 4.1.3 | `apps/api/src/handlers/search.ts` | Export `handleSearch`, `handleContext`. Move from index.ts. |
| 4.1.4 | `apps/api/src/handlers/billing.ts` | Export `handleBillingStatus`, `handleBillingCheckout`, `handleBillingPortal`, `handleBillingWebhook`. Move from index.ts. |
| 4.1.5 | `apps/api/src/handlers/admin.ts` | Export workspace/api-key admin and `handleReprocessDeferredWebhooks`, `handleAdminBillingHealth`. Move from index.ts. |
| 4.1.6 | `apps/api/src/handlers/exportImport.ts` | Export `handleExport`, `handleImport`. Move from index.ts. |
| 4.1.7 | `apps/api/src/auth.ts` | New file. Export `authenticate`, `extractApiKey`, `requireAdmin`, and any key-hashing helpers used only for auth. |
| 4.1.8 | `apps/api/src/cors.ts` | New file. Export CORS helpers (makeCorsHeaders, parseAllowedOrigins, isOriginAllowed, set/clear/getCorsHeadersForRequest). Move from index.ts. |
| 4.1.9 | `apps/api/src/audit.ts` | New file. Export `emitAuditLog` and any audit-only helpers. Move from index.ts. |
| 4.1.10 | `apps/api/src/index.ts` | Reduce to: CORS preflight (OPTIONS), healthz, createSupabaseClient, then call router; in finally, emitAuditLog and request_completed log. Pass env, supabase, auditCtx, requestId into router. Keep RateLimitDO export and fetch handler signature. No business logic in index.ts. |

### 4.2 Shared helpers

| Task | File | Action |
|------|------|--------|
| 4.2.1 | `apps/api/src/response.ts` or keep in index | Centralize `jsonResponse`, `emptyResponse`, `createHttpError`, and possibly `attachRequestIdToErrorPayload` so handlers and router can use them. |
| 4.2.2 | `apps/api/src/requestId.ts` or similar | Centralize request-id get/set/clear and `getRequestIdHeaders` if used in multiple places. |

### 4.3 Preserve behavior

- Run full test suite after each big move. Prefer moving one handler at a time and running tests so regressions are easy to spot.
- Keep the same export surface: `RateLimitDO`, `createSupabaseClient`, and any other exported symbols used by tests or wrangler.

### Phase 4 done when

- [ ] index.ts is under ~300 lines and only wires request → router → audit/log.
- [ ] All route handlers live in handlers/* and auth/cors/audit in their modules.
- [ ] **Refactor invariant** verified: same routes, status codes, JSON shapes, headers (CORS + x-request-id), auth and quota semantics; no external behavior change.
- [ ] pnpm lint, typecheck, test pass; smoke (or manual) still works.

---

## Phase 5: Schema validation and OpenAPI (fix wrong #4; implement Inv 4, Smart 8)

**Goal:** Critical request bodies validated with Zod; optional OpenAPI spec for public API.

**Contract ownership (pick one and document it):** To avoid drift between Zod and OpenAPI, declare a single source of truth:

- **Option A – Zod is source, OpenAPI derived:** Zod schemas are the source of truth. OpenAPI request/response schemas are generated from them (e.g. via `zod-to-openapi` or a small script) or hand-kept in sync and reviewed in the same PR as Zod changes. Document in `docs/API_REFERENCE.md` or in the spec: “Request/response schemas are derived from Zod in `packages/shared` (or `apps/api/src/schemas`).”
- **Option B – OpenAPI is source, Zod generated:** OpenAPI spec is the source of truth. Zod schemas are generated from the spec (e.g. via `openapi-zod-client` or a custom step) and used for runtime validation. Document: “Zod validators are generated from `docs/openapi.yaml`.”

Do **not** maintain two independent sources; otherwise they will drift. Pick one and stick to it.

**Chosen: Option A.** Implemented in `apps/api/src/contracts/`; task breakdown in `docs/PHASE5_VALIDATION.md`.

### 5.1 Add Zod and schemas

| Task | File | Action |
|------|------|--------|
| 5.1.1 | Root or `packages/shared` | Add dependency: `zod`. |
| 5.1.2 | `packages/shared` or `apps/api/src/schemas` | Define Zod schemas: `memoryInsertSchema` (user_id, text, namespace?, metadata?), `searchPayloadSchema` (user_id, query, namespace?, top_k?, page?, page_size?, filters?), `importBodySchema` (artifact_base64, mode?). Export them. |
| 5.1.3 | Handlers (memories, search, exportImport) | After `safeParseJson`, run `.safeParse(data)` on the schema. On failure, return 400 with a consistent shape, e.g. `{ error: { code: "VALIDATION_ERROR", message: "...", details: zodError.flatten() } }`. |
| 5.1.4 | Optional | Use Zod schema to derive TypeScript types and re-export in shared so SDK and API stay in sync. |

### 5.2 OpenAPI contract

| Task | File | Action |
|------|------|--------|
| 5.2.1 | `docs/openapi.yaml` or `packages/api-spec/openapi.yaml` | New file. OpenAPI 3 spec for: /healthz, /v1/memories (POST, GET), /v1/memories/{id} (GET, DELETE), /v1/search (POST), /v1/context (POST), /v1/usage/today (GET), /v1/billing/status (GET), /v1/billing/checkout (POST), /v1/export (POST), /v1/import (POST). Request/response schemas can mirror Zod or be written by hand. Security: apiKey (bearer). |
| 5.2.2 | Optional | Add a script or CI step to validate that responses in tests (or a single contract test) match the OpenAPI response schemas. |
| 5.2.3 | `docs/API_REFERENCE.md` | Add a line: “Machine-readable spec: docs/openapi.yaml (or packages/api-spec/openapi.yaml).” |

### Phase 5 done when

- [ ] **Contract ownership** is chosen (Zod → OpenAPI or OpenAPI → Zod) and documented in API_REFERENCE or the spec; no two independent sources.
- [ ] Memory ingest, search/context, and import bodies are validated with Zod; invalid payloads return 400 with a consistent error shape.
- [ ] OpenAPI spec exists and documents the main public endpoints and is kept in sync per the chosen source of truth.
- [ ] Optional: contract test or CI step that checks responses against the spec.

---

## Phase 6: Observability and security (fix wrong #10, #9; implement Inv 5, Inv 6)

**Goal:** Golden metrics and one “health view” documented; PayU secrets explicitly listed; optional auth-failure rate limit.

### 6.1 Golden metrics and health view

| Task | File | Action |
|------|------|--------|
| 6.1.1 | `docs/OBSERVABILITY.md` | Add “Golden metrics” section: e.g. (1) request count by route, (2) error rate by route (4xx/5xx), (3) latency p50/p99 by route, (4) cap_exceeded count, (5) PayU webhook received/verified/processed/failed. For each, state how to get it (e.g. Cloudflare Workers analytics, or log aggregation). |
| 6.1.2 | `docs/OBSERVABILITY.md` | Add “Health view” section: one dashboard or query that answers “Is the API healthy?” (e.g. error rate < X%, latency p99 < Y ms, webhook failure count). When to page: e.g. error rate above Z or webhook failures > N in 5 min. |
| 6.1.3 | `docs/ALERTS.md` | Tie existing alert thresholds to the golden metrics; reference OBSERVABILITY.md for the health view. |

### 6.2 Security hardening

| Task | File | Action |
|------|------|--------|
| 6.2.1 | `docs/SECURITY.md` | Add “PayU” subsection (if not already done in Phase 1): list PAYU_MERCHANT_KEY, PAYU_MERCHANT_SALT, PAYU_WEBHOOK_SECRET (if used); storage and rotation. |
| 6.2.2 | `docs/PROD_SETUP_CHECKLIST.md` | Ensure “PayU (production) setup” explicitly lists every PayU secret and where to set it (e.g. wrangler secret put). |
| 6.2.3 | Optional | In auth flow: after invalid API key or admin token, increment a counter (e.g. per-IP or per-key in Durable Object or KV); if over threshold in a window, return 429. Document in SECURITY.md and OPERATIONS. |

### Phase 6 done when

- [ ] OBSERVABILITY.md has golden metrics and one health view; ALERTS references them.
- [ ] PayU secrets are explicitly listed in SECURITY.md and PROD_SETUP_CHECKLIST.
- [ ] Optional: auth-failure rate limit implemented and documented.

---

## Phase 7: Tests and DX (fix wrongs #7, #8; implement Smart 10, Smart 11, Smart 12)

**Goal:** Typed mocks; Stripe removed from vitest setup; runbook consistency and CI check; one Quickstart path.

### 7.1 Test types and Vitest setup

| Task | File | Action |
|------|------|--------|
| 7.1.1 | `apps/api/tests/helpers/mocks.ts` or similar | New file. Define minimal `MockEnv` (extends Partial<Env> with required RATE_LIMIT_DO stub) and `MockSupabase` type (or interface) that has the methods your tests use (from, rpc, insert, select, single, eq, etc.). Export factory functions that return typed mocks. |
| 7.1.2 | `apps/api/tests/*.ts` | Replace `as any` and env/supabase stubs with the typed mocks. Remove `eslint-disable @typescript-eslint/no-explicit-any` where possible. |
| 7.1.3 | `vitest.setup.ts` | Remove or replace the Stripe mock. If you need a global for billing tests, add a PayU-related stub only if used; otherwise delete the Stripe mock. |

### 7.2 Runbook consistency and CI

| Task | File | Action |
|------|------|--------|
| 7.2.1 | All runbooks | After Phase 1, do one read-through of RELEASE_RUNBOOK, PROD_READY, PROD_SETUP_CHECKLIST, BILLING_RUNBOOK, OPERATIONS: ensure every env var and command matches the code. Fix any leftover Stripe or wrong PayU variable names. |
| 7.2.2 | CI | Phase 1 already added `check:docs-billing`. Optionally extend `scripts/check_docs_billing.mjs` to also grep for “STRIPE_PRICE” or “STRIPE_SECRET” in docs and fail if found. |

### 7.3 Developer experience

| Task | File | Action |
|------|------|--------|
| 7.3.1 | `docs/README.md` or root `README.md` | Add or tighten “Quickstart” section: (1) clone, (2) pnpm install, (3) copy .env.example and apps/api/.dev.vars.template, (4) set SUPABASE_* and at least API_KEY_SALT, MASTER_ADMIN_TOKEN, EMBEDDINGS_MODE=stub, (5) pnpm db:migrate (with DATABASE_URL), (6) pnpm dev, (7) one curl or SDK example: ingest one memory and call search. Link to QUICKSTART.md for full detail. |
| 7.3.2 | Optional | Add a `docker-compose.yml` or `scripts/local-supabase.sh` that runs Postgres + pgvector (and optionally Supabase API) so new devs can start without a cloud Supabase project. Document in QUICKSTART. |

### Phase 7 done when

- [ ] Tests use typed mocks; no Stripe in vitest.setup.
- [ ] Runbooks and checklists match code; CI check:docs-billing (and optional Stripe grep) passes.
- [ ] README Quickstart is a single, copy-paste-friendly path; optional local Supabase path documented.

---

## Execution checklist (high level)

- [ ] **Phase 1** – Docs PayU-only; CI doc check.
- [ ] **Phase 2** – Single Env; 405 for wrong method.
- [ ] **Phase 3** – Dashboard Load more + error boundary.
- [ ] **Phase 4** – Worker split into router + handlers + auth/cors/audit.
- [ ] **Phase 5** – Zod validation; OpenAPI spec.
- [ ] **Phase 6** – Golden metrics + health view; PayU secrets in SECURITY/PROD_SETUP.
- [ ] **Phase 7** – Typed mocks; vitest Stripe removed; runbook pass; Quickstart in README.

After all phases, every item in **Part 1 (What’s Wrong)** is addressed and every item in **Part 2 (Improvements)** is implemented.
