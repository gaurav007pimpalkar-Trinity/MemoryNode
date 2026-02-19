# Recommended Commit Sequence

Use this order so each commit is self-contained, reviewable, and safe to revert. Run from repo root.

---

## Sequence (11 commits)

### 1. **chore(ci): pin pnpm, add audit, set VITE_API_BASE_URL for tests**
- `.github/workflows/ci.yml`  
- **Why first:** CI and tooling; no app logic. Other commits will rely on CI passing.

### 2. **chore: drop obsolete doc artifacts from gitignore**
- `.gitignore` (remove CTO_ONBOARDING_REPORT, CTO_EVIDENCE_INDEX, CTO_ARCHITECTURE_ASCII if still listed; or keep as-is if already removed)  
- **Why:** Housekeeping before doc deletions.

### 3. **feat(api): new-key rate limit 15 RPM for first 48h**
- `apps/api/src/limits.ts` (NEW_KEY_GRACE_MS, getRateLimitMax)
- `apps/api/src/env.ts` (RATE_LIMIT_MAX on Env)
- `apps/api/src/auth.ts` (keyCreatedAt, created_at, rateLimit(,,auth), getRateLimitMax)
- `apps/api/src/rateLimitDO.ts` (read limit from request body)
- `apps/api/tests/helpers/rate_limit_do.ts` (stub accepts body.limit)
- `apps/api/tests/rate_limit_do.test.ts` (new-key 48h test)
- **Why:** Single feature; all handlers that call rateLimit come in next commit.

### 4. **feat(api): pass auth to rateLimit in all handlers**
- `apps/api/src/handlers/billing.ts` (3 places)
- `apps/api/src/handlers/context.ts`
- `apps/api/src/handlers/eval.ts` (4 places)
- `apps/api/src/handlers/export.ts`
- `apps/api/src/handlers/import.ts`
- `apps/api/src/handlers/memories.ts` (4 places)
- `apps/api/src/handlers/search.ts` (3 places)
- `apps/api/src/handlers/usage.ts`
- **Why:** Depends on auth having keyCreatedAt; no new behavior except using it.

### 5. **feat(api): admin session cleanup endpoint**
- `apps/api/src/handlers/admin.ts` (handleCleanupExpiredSessions)
- `apps/api/src/router.ts` (route + RouterHandlers)
- `apps/api/src/index.ts` (export)
- `apps/api/src/workerApp.ts` (KNOWN_PATH_ALLOWED_METHODS, export)
- **Why:** Standalone admin feature; no dependency on rate-limit changes.

### 6. **chore(shared): update plans comment for new-key RPM**
- `packages/shared/src/plans.ts` (comment only)
- **Why:** Doc accuracy after rate-limit feature.

### 7. **test(dashboard): ensureDashboardSession and remove unused imports**
- `apps/dashboard/tests/dashboard_trust.test.ts`
- **Why:** Test-only; satisfies G4.

### 8. **chore: vitest coverage config and test:coverage script**
- `vitest.config.ts`
- `package.json` (test:coverage, @vitest/coverage-v8)
- **Why:** Optional quality gate; independent.

### 9. **docs: production requirements, prod ready handoff, G5, plan codes**
- `docs/PRODUCTION_REQUIREMENTS.md` (new)
- `docs/PROD_READY.md` (production requirements ref, G5 checklist, “What you need to do”)
- `docs/RELEASE_RUNBOOK.md` (G5 live step)
- `docs/API_REFERENCE.md` (plan codes internal vs external, 48h)
- `docs/README.md` (links to PRODUCTION_REQUIREMENTS, PROD_READY)
- **Why:** Docs that reference the new behavior and ops flow.

### 10. **docs: remove obsolete plans and consolidate**
- Delete: `docs/BEST_IN_MARKET_PLAN.md`, `docs/BEST_IN_MARKET_STATUS.md`, `docs/DASHBOARD_TEST_CHECKLIST.md`, `docs/DEPLOYMENT.md`, `docs/IMPROVEMENT_PLAN.md`, `docs/PHASE5_VALIDATION.md`, `docs/PRE_PUSH_CHECKLIST.md`
- `docs/ARCHITECTURE_CEO.md` (footer link)
- **Why:** Single “doc cleanup” commit; reduces noise.

### 11. **docs: ops, deploy, config, and verification**
- `docs/OPERATIONS.md`, `docs/DASHBOARD_DEPLOY.md`, `docs/DASHBOARD_SESSION_SETUP.md`, `docs/PROD_SETUP_CHECKLIST.md`
- `scripts/check_config.mjs`, `scripts/__tests__/check_config.test.ts`, `scripts/check_docs_billing.mjs`, `scripts/ci_trust_gates.mjs`
- `docs/FINAL_PREPROD_VERIFICATION.md` (new)
- `apps/dashboard/wrangler.toml` (if you use it for dashboard deploy; otherwise commit separately or omit)
- **Why:** Operational and verification docs/scripts in one pass.

---

## Optional: single squash commit

If you prefer one commit for the whole branch:

```text
feat(api): new-key rate limit 48h, session cleanup, docs and prod readiness

- New API keys: 15 RPM for first 48h (limits, auth, rateLimitDO, handlers)
- Admin POST /admin/sessions/cleanup for expired dashboard sessions
- PRODUCTION_REQUIREMENTS, PROD_READY handoff, G5 live step, plan codes
- Remove obsolete docs (BEST_IN_MARKET_*, DEPLOYMENT, etc.)
- CI: pnpm pin, audit, VITE_API_BASE_URL for tests
- Vitest coverage config and test:coverage script
- Dashboard trust test: ensureDashboardSession; lint fixes
```

---

## Quick commands (by commit)

```bash
# 1
git add .github/workflows/ci.yml && git commit -m "chore(ci): pin pnpm 10.0.0, add audit, set VITE_API_BASE_URL for tests"

# 2
git add .gitignore && git commit -m "chore: drop obsolete doc artifacts from gitignore"

# 3
git add apps/api/src/limits.ts apps/api/src/env.ts apps/api/src/auth.ts apps/api/src/rateLimitDO.ts apps/api/tests/helpers/rate_limit_do.ts apps/api/tests/rate_limit_do.test.ts && git commit -m "feat(api): new-key rate limit 15 RPM for first 48h"

# 4
git add apps/api/src/handlers/billing.ts apps/api/src/handlers/context.ts apps/api/src/handlers/eval.ts apps/api/src/handlers/export.ts apps/api/src/handlers/import.ts apps/api/src/handlers/memories.ts apps/api/src/handlers/search.ts apps/api/src/handlers/usage.ts && git commit -m "feat(api): pass auth to rateLimit in all handlers"

# 5
git add apps/api/src/handlers/admin.ts apps/api/src/router.ts apps/api/src/index.ts apps/api/src/workerApp.ts && git commit -m "feat(api): admin session cleanup endpoint"

# 6
git add packages/shared/src/plans.ts && git commit -m "chore(shared): update plans comment for new-key RPM"

# 7
git add apps/dashboard/tests/dashboard_trust.test.ts && git commit -m "test(dashboard): ensureDashboardSession and remove unused imports"

# 8
git add vitest.config.ts package.json && git commit -m "chore: vitest coverage config and test:coverage script"

# 9
git add docs/PRODUCTION_REQUIREMENTS.md docs/PROD_READY.md docs/RELEASE_RUNBOOK.md docs/API_REFERENCE.md docs/README.md && git commit -m "docs: production requirements, prod ready handoff, G5, plan codes"

# 10
git add docs/ARCHITECTURE_CEO.md && git add docs/BEST_IN_MARKET_PLAN.md docs/BEST_IN_MARKET_STATUS.md docs/DASHBOARD_TEST_CHECKLIST.md docs/DEPLOYMENT.md docs/IMPROVEMENT_PLAN.md docs/PHASE5_VALIDATION.md docs/PRE_PUSH_CHECKLIST.md && git commit -m "docs: remove obsolete plans and consolidate"

# 11
git add docs/OPERATIONS.md docs/DASHBOARD_DEPLOY.md docs/DASHBOARD_SESSION_SETUP.md docs/PROD_SETUP_CHECKLIST.md scripts/check_config.mjs scripts/__tests__/check_config.test.ts scripts/check_docs_billing.mjs scripts/ci_trust_gates.mjs docs/FINAL_PREPROD_VERIFICATION.md
# optional: git add apps/dashboard/wrangler.toml
git commit -m "docs: ops, deploy, config, and verification"
```

**Note:** Commit 10: stage deleted files with `git add docs/BEST_IN_MARKET_PLAN.md docs/BEST_IN_MARKET_STATUS.md ...` (or `git add -u docs/`); then add `docs/ARCHITECTURE_CEO.md` and commit.
