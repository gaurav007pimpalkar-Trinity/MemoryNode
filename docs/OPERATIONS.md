# Operations Runbook (Prod/Staging)

## A) Secrets Inventory
| Secret | Where to set | What it affects | Rotation guidance |
| --- | --- | --- | --- |
| `API_KEY_SALT` | Cloudflare Worker secret (prod/staging); local `.env.gate`/`.env.prod.smoke` for checks | API key hashing; must match `app_settings.api_key_salt` in DB | Rotate only if compromised; must align DB `app_settings.api_key_salt` + re-issue keys |
| `MASTER_ADMIN_TOKEN` | Cloudflare Worker secret; local env for admin scripts | Admin plane (`/v1/workspaces`, `/v1/api-keys`); deploy scripts | Rotate if leaked; update all operators’ envs |
| `OPENAI_API_KEY` | Cloudflare Worker secret; local env for smoke when `EMBEDDINGS_MODE=openai` | Embeddings generation | Rotate per OpenAI best practices; ensure `EMBEDDINGS_MODE=openai` |
| `STRIPE_SECRET_KEY` | Cloudflare Worker secret (prod/staging); local for billing tests | Billing endpoints (checkout/portal/webhook) | Rotate via Stripe dashboard; update Worker secret; verify webhook after |
| `STRIPE_WEBHOOK_SECRET` | Cloudflare Worker secret; local for webhook tests | Stripe webhook verification | Rotate in Stripe dashboard; update Worker secret; replay test event |
| `CLOUDFLARE_API_TOKEN` | Local/CI (optional alternative to wrangler login) | Deploy via wrangler | Rotate if leaked; ensure token has Workers write scope |
| `SUPABASE_SERVICE_ROLE_KEY` | Cloudflare Worker secret; local for DB scripts | Supabase service access from Worker | Rotate via Supabase; update Worker secret; re-run smoke |
| `SUPABASE_URL` | Cloudflare Worker var/secret; local for smoke | Supabase endpoint | Update if project URL changes; align with DB URLs |

## B) Rollback Procedure
1) Identify last good git commit or wrangler version (from CI logs).
2) Check out that commit locally (or CI) and run:  
   `DEPLOY_ENV=production DEPLOY_CONFIRM=memorynode-prod DRY_RUN=0 node scripts/deploy_prod.mjs`
3) Confirm rollback: `curl -s https://<BASE_URL>/healthz` should show `status: "ok"` and `version/BUILD_VERSION` matching the rolled-back deploy.
4) If needed, revert DB changes manually (migrations are forward-only; prefer hotfix migration rather than reversal).

## C) Incident Checklist
- Rate limit DO failure: 500 errors mentioning `RATE_LIMIT_DO` missing; fix by ensuring wrangler binding exists per env and redeploy.
- Supabase connectivity issues: 500s with DB errors; verify `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; run `post_deploy_check` to confirm `/v1/usage/today` works.
- Stripe webhook failures: look for `billing_webhook_signature_invalid` / `billing_webhook_workspace_not_found`; check `infra/sql/016_webhook_events.sql` idempotency table and Cloudflare logs; replay webhook from Stripe dashboard after fixing secrets.
