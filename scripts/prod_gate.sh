#!/usr/bin/env bash
set -euo pipefail

if [[ -f ".env.gate" ]]; then
  echo "[gate] loading .env.gate"
  set -a
  # shellcheck disable=SC2046
  source <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env.gate)
  set +a
else
  echo "[gate] .env.gate not found. Create it from .env.gate.example with required vars:"
  echo "  DEPLOY_ENV, BASE_URL, DATABASE_URL (or SUPABASE_DB_URL), MEMORYNODE_API_KEY, DEPLOY_CONFIRM (prod), CLOUDFLARE_API_TOKEN (optional), DRY_RUN"
  exit 1
fi

echo "[gate] lint/typecheck/tests"
pnpm lint
pnpm typecheck
pnpm test

echo "[gate] staging dry-run deploy"
DEPLOY_ENV=staging DRY_RUN=1 pnpm deploy:staging

echo "[gate] production dry-run deploy"
DEPLOY_ENV=production DRY_RUN=1 DEPLOY_CONFIRM=memorynode-prod pnpm deploy:prod

echo "[gate] complete"
