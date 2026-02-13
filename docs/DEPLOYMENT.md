# Staging Deployment (push-button)

Use this runbook to deploy the Cloudflare Worker to staging, including DB migrations and a quick smoke test. Nothing runs automatically; you must invoke it manually with the right env vars.

## Prerequisites
- Cloudflare auth: `pnpm -C apps/api wrangler login` (or set `CLOUDFLARE_API_TOKEN`).
- Env vars (staging):
  - `STAGE=staging` (or `DEPLOY_ENV=staging`)
- `SUPABASE_DB_URL` (or `DATABASE_URL`) – staging Postgres
- `BASE_URL` – staging API base (e.g., https://api-staging.memorynode.ai)
- `MEMORYNODE_API_KEY` – staging API key for smoke
- Optional billing smoke: `PAYU_MERCHANT_KEY` + `PAYU_MERCHANT_SALT` (and PayU staging credentials in the platform)
- Optional `BUILD_VERSION` is auto-set by the deploy script (ISO timestamp). You can override by setting it in the environment before running.
 - GitHub secrets (recommended names) for CI/manual smokes: `MEMORYNODE_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `API_KEY_SALT`.

## Command
```
STAGE=staging SUPABASE_DB_URL=postgres://... \
BASE_URL=https://api-staging.memorynode.ai \
MEMORYNODE_API_KEY=mn_xxx \
pnpm deploy:staging
```

### What it does
1) Runs `pnpm release:gate:full` (code/config + db:migrate/verify + lint/typecheck/tests).  
2) Deploys: `pnpm -C apps/api wrangler deploy --env staging`.  
3) Post-deploy smoke: `GET /healthz` then `GET /v1/usage/today` with your API key.  
4) If `PAYU_MERCHANT_KEY` + `PAYU_MERCHANT_SALT` are set, runs `pnpm payu:webhook-test` (staging webhook).

If any step fails, the script exits non‑zero with a concise message (no secrets printed).

## Rollback (staging)
- List deployments: `pnpm -C apps/api wrangler deployments --env staging`
- Redeploy a previous build: `pnpm -C apps/api wrangler deploy --env staging --hash <deployment-id>`
- If DB migration caused issues, restore from backup (see BACKUP_RESTORE.md) and rerun `pnpm db:migrate`.

## Notes & Links
- Release gate details: `docs/RELEASE_GATE.md`
- Observability signals: `docs/OBSERVABILITY.md`
- Backups & restore drill: `docs/BACKUP_RESTORE.md`
- Perf baseline: `docs/PERFORMANCE.md`
- Dashboard manual checks: `docs/DASHBOARD_TEST_CHECKLIST.md`

---

# Production Deployment (guarded)

## Safety latch (must set)
- `STAGE=production` (or `DEPLOY_ENV=production`)
- `DEPLOY_CONFIRM=memorynode-prod` (exact match, required)

## Required env (prod)
- `SUPABASE_DB_URL` (or `DATABASE_URL`) – prod Postgres
- `BASE_URL` – prod API base (e.g., https://api.memorynode.ai)
- `MEMORYNODE_API_KEY` – prod API key for smoke
- Cloudflare auth: `pnpm -C apps/api wrangler login` or `CLOUDFLARE_API_TOKEN`
- Optional billing smoke: `PAYU_MERCHANT_KEY` + `PAYU_MERCHANT_SALT` (and prod PayU credentials in platform)
- Optional `BUILD_VERSION` is auto-set by the deploy script (ISO timestamp). You can override by setting it in the environment before running.

## Command
```
STAGE=production DEPLOY_CONFIRM=memorynode-prod \
SUPABASE_DB_URL=postgres://... \
BASE_URL=https://api.memorynode.ai \
MEMORYNODE_API_KEY=mn_xxx \
pnpm deploy:prod
```

### What it does
1) `pnpm release:gate:full` (CHECK_ENV=production inside; includes db:check).  
2) `pnpm -C apps/api wrangler deploy --env production`.  
3) Smoke: `GET /healthz` and `GET /v1/usage/today` with API key.  
4) If `PAYU_MERCHANT_KEY` + `PAYU_MERCHANT_SALT` are set, runs `pnpm payu:webhook-test` (prod webhook).

If `DEPLOY_CONFIRM` is missing/wrong, it refuses to run before touching anything.

## Rollback (prod)
- List deployments: `pnpm -C apps/api wrangler deployments --env production`
- Redeploy previous hash: `pnpm -C apps/api wrangler deploy --env production --hash <deployment-id>`
- If DB migration caused issues, restore from backup (see BACKUP_RESTORE.md) and rerun `pnpm db:migrate`.

---

## PayU Go-Live Runbook

### Exact env vars required
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_DB_URL` (or `DATABASE_URL`)
- `API_KEY_SALT`
- `MASTER_ADMIN_TOKEN`
- `BASE_URL`
- `MEMORYNODE_API_KEY`
- `PAYU_MERCHANT_KEY`
- `PAYU_MERCHANT_SALT`
- `PAYU_BASE_URL`
- `PAYU_VERIFY_URL`
- `PAYU_VERIFY_TIMEOUT_MS`
- `PAYU_CURRENCY`
- `PAYU_PRO_AMOUNT`
- `PAYU_PRODUCT_INFO`
- `PUBLIC_APP_URL`
- `PAYU_SUCCESS_PATH`
- `PAYU_CANCEL_PATH`
- `BILLING_WEBHOOKS_ENABLED`
- `BILLING_RECONCILE_ON_AMBIGUITY`

### Cloudflare deploy steps
1. Run release checks:
   - `pnpm release:gate:full`
2. Deploy Worker:
   - Staging: `pnpm -C apps/api wrangler deploy --env staging`
   - Production: `pnpm -C apps/api wrangler deploy --env production`
3. Confirm health:
   - `curl -sS \"$BASE_URL/healthz\"`

### Supabase migration apply steps
1. Apply schema changes:
   - `SUPABASE_DB_URL=postgres://... pnpm db:migrate`
2. Verify RLS + schema:
   - `SUPABASE_DB_URL=postgres://... pnpm db:verify-rls`
   - `SUPABASE_DB_URL=postgres://... pnpm db:verify-schema`
3. Confirm migration manifest:
   - `pnpm migrations:list`

### Validate after deploy
1. Billing status endpoint:
   - `curl -sS -H \"Authorization: Bearer $MEMORYNODE_API_KEY\" \"$BASE_URL/v1/billing/status\"`
   - Check `plan`, `plan_status`, `effective_plan`.
2. Run smoke:
   - `pnpm payu:smoke`
3. Run one test payment in PayU staging only:
   - Use staging merchant credentials and staging callback URLs.
   - Confirm callback hits `/v1/billing/webhook` and `plan_status` becomes `active` for the test workspace.

### Reprocess PayU webhook events
- Reprocess deferred events:
  - `curl -sS -X POST -H \"x-admin-token: $MASTER_ADMIN_TOKEN\" \"$BASE_URL/admin/webhooks/reprocess?status=deferred&limit=50\"`
- Reprocess failed events:
  - `curl -sS -X POST -H \"x-admin-token: $MASTER_ADMIN_TOKEN\" \"$BASE_URL/admin/webhooks/reprocess?status=failed&limit=50\"`
- Inspect billing diagnostic:
  - `curl -sS -H \"x-admin-token: $MASTER_ADMIN_TOKEN\" \"$BASE_URL/v1/admin/billing/health\"`

### Rollback options (PayU-specific)
1. Disable billing checks gate quickly (webhook processing):
   - Set `BILLING_WEBHOOKS_ENABLED=0` in Worker env and redeploy.
2. Redeploy previous Worker build:
   - `pnpm -C apps/api wrangler deployments --env <stage>`
   - `pnpm -C apps/api wrangler deploy --env <stage> --hash <deployment-id>`
3. Revert to last known-good entitlement (manual SQL, controlled change):
   - Mark current row inactive and re-activate prior row in `workspace_entitlements` for affected workspace.
   - Keep `source_txn_id` uniqueness intact; do not create duplicate entitlement rows for same txn.
