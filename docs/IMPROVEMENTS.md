# MemoryNode: What’s Wrong & How to Make It Invincible and Smart

This document lists concrete issues in the repo and improvements to make the product robust, maintainable, and “invincible” (resilient, secure, observable) and “smart” (easier to evolve and operate).

---

## Part 1: What’s Wrong

### 1. Documentation vs implementation (critical)

- **Stripe vs PayU**: Billing is implemented with **PayU** (checkout, webhook, verify, entitlements). Many docs still describe **Stripe** (env vars, runbooks, API reference, PROD_SETUP_CHECKLIST, RELEASE_RUNBOOK, BILLING_RUNBOOK, OPERATIONS, ALERTS, OBSERVABILITY, TROUBLESHOOTING_BETA, SECURITY). New operators and automation will follow wrong instructions.
- **Impact**: Wrong secrets, failed webhooks, incorrect runbooks during incidents.

### 2. Duplicate / out-of-sync `Env` type

- **`apps/api/src/index.ts`** defines a full `interface Env` (includes `RATE_LIMIT_DO`, PayU vars, etc.).
- **`apps/api/src/env.ts`** defines another `Env` (no `RATE_LIMIT_DO`, has PayU).
- Tests and config guards use `env.ts`; the Worker entrypoint uses the inline `Env` in `index.ts`. Adding a new env var in one place can be missed in the other.
- **Impact**: Type drift, missing validation, confusing onboarding.

### 3. Single giant API file

- **`apps/api/src/index.ts`** is ~4,500+ lines: routing, auth, billing (PayU), search, memories, export/import, admin, CORS, audit, rate limit, error handling.
- **Impact**: Hard to navigate, test in isolation, or onboard; high risk of merge conflicts and accidental breakage.

### 4. No machine-readable API contract

- No OpenAPI/Swagger or shared Zod (or similar) schemas. Validation is ad-hoc (`safeParseJson` + manual checks). Request/response shapes are only in docs and TypeScript types.
- **Impact**: No generated clients, no automated contract tests, no single source of truth for “allowed” request bodies (e.g. metadata shape, query length).

### 5. No 405 Method Not Allowed

- Unknown path → 404. Wrong method on a known path (e.g. `GET /v1/memories/xyz` vs `DELETE`) is handled by the route; if a path exists but method isn’t handled, flow can fall through to 404 without a clear “Method Not Allowed” message.
- **Impact**: Confusing for API consumers; less RESTful and harder to debug.

### 6. Dashboard: encoding typo and small UX gaps

- **ActivationView** shows `Loadingâ€¦` (broken UTF-8 for “Loading…”).
- Search “Load more” doesn’t use API’s `total` / `has_more` (no “No more results” or total count).
- No global error boundary; no retry/back from generic error state.
- **Impact**: Unprofessional look; slightly worse UX and resilience.

### 7. Test mocks use `any` heavily

- Many API tests use `as any` and `eslint-disable @typescript-eslint/no-explicit-any` for Supabase and env mocks.
- **Impact**: Mocks can drift from real interfaces; refactors may not be caught by tests.

### 8. Vitest setup still references Stripe

- **`vitest.setup.ts`** mocks `Stripe`; billing code is PayU-only.
- **Impact**: Dead or misleading test setup; confusion when adding billing tests.

### 9. Secret-scan patterns

- Secret scan looks for Stripe-style `whsec_*` (correct to keep for any Stripe future), but runbooks/docs say “Stripe” for current production; PayU secrets are not explicitly called out in the same way in checklist docs.
- **Impact**: Operators might think Stripe is required for current prod; PayU secret handling is less visible.

### 10. Observability: no golden metrics

- Logs and `x-request-id` exist; no documented “golden metrics” (e.g. latency p50/p99, error rate by route, usage vs cap) or a single dashboard/query that answers “is the API healthy?”
- **Impact**: Incidents take longer to diagnose; no clear SLO/alert strategy.

---

## Part 2: Improvements to Make It Invincible and Smart

### Invincible (resilient, secure, observable)

| # | Improvement | Why |
|---|-------------|-----|
| 1 | **Fix doc/billing alignment** | Make PayU the single source of truth in docs: replace Stripe env vars and steps in QUICKSTART, PROD_SETUP_CHECKLIST, RELEASE_RUNBOOK, BILLING_RUNBOOK, OPERATIONS, ALERTS, OBSERVABILITY, API_REFERENCE, TROUBLESHOOTING_BETA, SECURITY. Add a short “Billing (PayU)” section in README and point all billing ops there. Keep Stripe mentions only if you explicitly plan to support Stripe again. |
| 2 | **Single `Env` source of truth** | Define `Env` once (e.g. in `env.ts`) with all Worker vars including `RATE_LIMIT_DO` and PayU. Export it and use it from `index.ts`. Remove the duplicate `Env` from `index.ts`. Optionally add a small runtime “required for this stage” check from the same place. |
| 3 | **405 for wrong method** | For known paths (e.g. `/v1/memories`, `/v1/memories/:id`, `/v1/search`, …), if the request method is not in the allowed set, return `405 Method Not Allowed` with `Allow` header instead of falling through to 404. |
| 4 | **Schema-based request validation** | Introduce Zod (or similar) for critical bodies: memory ingest, search/context, import. Validate after `safeParseJson` and return 400 with a consistent error shape (e.g. `invalid_field` + message). Reuse the same schemas in SDK types and (if you add it) OpenAPI. |
| 5 | **Golden metrics + one health view** | Document 3–5 golden metrics (e.g. request count by route, error rate by route, latency p99, cap_exceeded count, webhook success/failure). Add a short “Health view” section in OBSERVABILITY.md: one query or dashboard that answers “is the API healthy?” and when to page. Tie ALERTS.md thresholds to these. |
| 6 | **Security hardening** | Keep RLS and verify-before-grant; add: (a) explicit list of PayU (and any future provider) secrets in SECURITY.md and PROD_SETUP_CHECKLIST; (b) rate limit for auth failures (optional); (c) optional CAPTCHA or abuse signal for signup/checkout if needed later. |

### Smart (maintainable, evolvable, easy to operate)

| # | Improvement | Why |
|---|-------------|-----|
| 7 | **Split the Worker into modules** | Break `index.ts` into: `router.ts` (path + method → handler), `handlers/memories.ts`, `handlers/search.ts`, `handlers/billing.ts`, `handlers/admin.ts`, `handlers/exportImport.ts`, `auth.ts`, `cors.ts`, `audit.ts`. Keep `index.ts` as a thin fetch handler that delegates. Same process, same Worker; much easier to work on and test. |
| 8 | **OpenAPI (or equivalent) contract** | Add an OpenAPI 3 spec (or generate from Zod if you use it) for the public API. Use it for: generated SDK types, optional client codegen, and contract tests (e.g. “response matches schema”). Keeps docs and implementation in sync. |
| 9 | **Dashboard: fix typo and small UX** | Replace `Loadingâ€¦` with `Loading…` in ActivationView; use search API’s `total`/`has_more` for “Load more” (disable when no more, optionally show “X results”); add a simple error boundary and a “Retry” or “Back” on generic errors. |
| 10 | **Tighten test types** | Replace `as any` in tests with minimal typed interfaces (e.g. `MockSupabase`, `MockEnv`) so refactors break tests when the real API changes. Remove or update Stripe mock in `vitest.setup.ts` to match current billing (PayU). |
| 11 | **Runbook consistency** | After fixing Stripe → PayU, do a single pass over RELEASE_RUNBOOK, PROD_READY, PROD_SETUP_CHECKLIST, BILLING_RUNBOOK, OPERATIONS: ensure every env var and step matches the code and PayU. Add a “Doc vs code” check in CI (e.g. grep for STRIPE in docs and fail if billing is PayU-only and Stripe is still in “required” sections). |
| 12 | **Developer experience** | One “Quickstart” path in README: clone → env template → migrate → `pnpm dev` → one curl (or SDK call) for ingest + search. Optional: `docker-compose` or script for local Supabase + Worker so new devs don’t need to create a Supabase project first. |

---

## Part 3: Suggested order of work

1. **Doc/billing alignment** (Stripe → PayU everywhere) — unblocks correct ops and onboarding.
2. **Single `Env`** — quick, prevents future config bugs.
3. **Dashboard typo + “Load more” / error UX** — fast wins.
4. **405 for wrong method** — small, clear API behavior.
5. **Split Worker into modules** — enables parallel work and safer refactors.
6. **Zod (or similar) + optional OpenAPI** — better validation and a single contract.
7. **Golden metrics + health view** — better incidents and SLOs.
8. **Test types + vitest Stripe cleanup** — more reliable refactors.

This order keeps risk low while making the repo more invincible (reliable, secure, observable) and smart (easier to change and operate).
