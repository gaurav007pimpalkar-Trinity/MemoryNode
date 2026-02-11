# Secrets & Credential Hygiene

## Rules
- Never commit real credentials to git.
- Use tracked templates only:
  - `.env.example`
  - `apps/api/.dev.vars.template`
  - `apps/dashboard/.env.example`
- Put real runtime secrets in Cloudflare Worker secrets (`wrangler secret put <NAME>` or Cloudflare Dashboard).

## Local Files
- Real values belong in local untracked files only (`.env`, `.env.local`, `.dev.vars`, `.dev.vars.production`, etc.).
- Do not add backup copies of env/wrangler files to git.

## Required Scans
- Staged diff scan (pre-commit style):
  - `pnpm secrets:check`
- Full tracked-file scan:
  - `pnpm secrets:check:tracked`
- CI enforces tracked-file scanning and fails fast on detection.

## Optional Pre-Commit Hook
- Example hook script: `scripts/precommit.sh`
- One simple setup:
  - `cp scripts/precommit.sh .git/hooks/pre-commit`
  - `chmod +x .git/hooks/pre-commit`
- Husky users can call the same command sequence from `.husky/pre-commit`.

## Rotation Playbook (if a secret is exposed)
1. Revoke/rotate immediately in provider dashboard.
2. Update Cloudflare Worker secret values (staging + production).
3. Redeploy and verify health/smoke checks.
4. Invalidate dependent credentials/tokens (API keys, sessions, webhooks).
5. Document incident, blast radius, and closure.

### OpenAI (`OPENAI_API_KEY`)
- Generate a new key in OpenAI dashboard.
- Disable old key.
- Update Worker secret and redeploy.

### Supabase (`SUPABASE_SERVICE_ROLE_KEY`)
- Rotate service-role key in Supabase project settings.
- Update Worker secret and any secure automation that uses it.
- Redeploy and run DB/API smoke tests.

### Stripe (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`)
- Roll API key and webhook signing secret in Stripe dashboard.
- Update Worker secrets and webhook endpoint config.
- Replay a test webhook and verify idempotency path.

### Internal Admin Secrets (`MASTER_ADMIN_TOKEN`, `API_KEY_SALT`)
- Generate fresh random values.
- Update Worker secrets.
- For `API_KEY_SALT`, rotate API keys after update.

## GitHub Secret Scanning
- Enable GitHub Secret Scanning and Push Protection on the repository (if hosted on GitHub with eligible plan).
- On alert:
  1. Treat as active incident.
  2. Rotate secret first, then clean repository/workflow exposure.
  3. Close alert only after redeploy + verification.
