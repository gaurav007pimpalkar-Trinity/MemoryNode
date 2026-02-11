#!/usr/bin/env bash
set -euo pipefail

echo "[precommit] scanning staged diff for secrets"
pnpm secrets:check

echo "[precommit] scanning tracked files for secrets"
pnpm secrets:check:tracked
