#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG=".tmp/e2e_smoke.log"
mkdir -p .tmp
: >"$LOG"

if [[ -f .env.e2e ]]; then
  # shellcheck disable=SC1091
  source .env.e2e
fi

# Allow MEMORYNODE_API_KEY as an alias.
if [[ -z "${E2E_API_KEY:-}" && -n "${MEMORYNODE_API_KEY:-}" ]]; then
  export E2E_API_KEY="$MEMORYNODE_API_KEY"
fi

BASE_URL="${BASE_URL:-https://api-staging.memorynode.ai}"
USE_LOCAL_DEV=0
if [[ "$BASE_URL" == http://127.0.0.1:* || "$BASE_URL" == http://localhost:* ]]; then
  USE_LOCAL_DEV=1
fi

if [[ -z "${E2E_API_KEY:-}" ]]; then
  echo "Missing required env vars: E2E_API_KEY (or MEMORYNODE_API_KEY)" >&2
  exit 1
fi

WRANGLER_PID=""
cleanup() {
  if [[ -n "$WRANGLER_PID" ]] && ps -p "$WRANGLER_PID" >/dev/null 2>&1; then
    kill "$WRANGLER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

fail() {
  echo "E2E smoke failed: $1" >&2
  if [[ -f "$LOG" ]]; then
    tail -n 200 "$LOG" || true
  fi
  exit 1
}

pick_port() {
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("", 0))
print(s.getsockname()[1])
s.close()
PY
    return
  fi

  if command -v python >/dev/null 2>&1; then
    python - <<'PY'
import socket
s = socket.socket()
s.bind(("", 0))
print(s.getsockname()[1])
s.close()
PY
    return
  fi

  node -e "const n=require('node:net');const s=n.createServer();s.listen(0,()=>{console.log(s.address().port);s.close();});"
}

if [[ "$USE_LOCAL_DEV" -eq 1 ]]; then
  REQUIRED_VARS=(E2E_API_KEY SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY API_KEY_SALT)
  missing=()
  for var in "${REQUIRED_VARS[@]}"; do
    if [[ -z "${!var:-}" ]]; then
      missing+=("$var")
    fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "Missing required env vars for local dev smoke: ${missing[*]}" >&2
    exit 1
  fi

  PORT="$(pick_port)"
  export PORT
  export EMBEDDINGS_MODE="${EMBEDDINGS_MODE:-stub}"

  WRANGLER_TOML="$ROOT_DIR/apps/api/wrangler.toml"
  if [[ ! -f "$WRANGLER_TOML" ]] || ! grep -q 'durable_objects' "$WRANGLER_TOML"; then
    echo "ERROR: wrangler.toml is missing durable_objects section (expected RATE_LIMIT_DO)" >&2
    exit 1
  fi
  if ! grep -q 'binding *= *"RATE_LIMIT_DO"' "$WRANGLER_TOML"; then
    echo "ERROR: wrangler.toml is missing durable_objects binding RATE_LIMIT_DO" >&2
    sed -n '/durable_objects/,+12p' "$WRANGLER_TOML"
    exit 1
  fi

  echo "Starting API dev server on port $PORT..."
  pnpm --filter @memorynode/api run dev -- --port "$PORT" --log-level error >"$LOG" 2>&1 &
  WRANGLER_PID=$!

  printf "Waiting for /healthz"
  healthy=0
  for _ in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null; then
      healthy=1
      break
    fi
    printf "."
    sleep 1
  done
  if [[ "$healthy" -ne 1 ]]; then
    echo " failed"
    fail "healthz not ready"
  fi
  echo " ok"
  BASE_URL="http://127.0.0.1:${PORT}"
  echo "Base URL (local dev): $BASE_URL"
else
  echo "Base URL (remote): $BASE_URL"
fi

redact_headers() {
  local line token masked
  while IFS= read -r line; do
    if [[ "$line" =~ ^[Aa]uthorization:[[:space:]]*[Bb]earer[[:space:]]+([^[:space:]]+) ]]; then
      token="${BASH_REMATCH[1]}"
      masked="$(mask_secret "$token")"
      line="${line/$token/$masked}"
    fi
    if [[ "$line" =~ ^[Xx]-[Aa][Pp][Ii]-[Kk][Ee][Yy]:[[:space:]]*([^[:space:]]+) ]]; then
      token="${BASH_REMATCH[1]}"
      masked="$(mask_secret "$token")"
      line="${line/$token/$masked}"
    fi
    printf '%s\n' "$line"
  done
}

mask_secret() {
  local value="${1:-}"
  local len="${#value}"
  if (( len == 0 )); then
    printf '%s' '***redacted***'
    return
  fi
  if (( len <= 10 )); then
    local left_count=2
    local right_count=2
    if (( len < 2 )); then
      left_count=1
      right_count=1
    fi
    printf '%s...%s' "${value:0:left_count}" "${value: -right_count}"
    return
  fi
  printf '%s...%s' "${value:0:6}" "${value: -4}"
}

get_status_code() {
  awk '/^HTTP/{code=$2} END{print code}' "$1"
}

call_health() {
  local header_file body_file status
  header_file="$(mktemp)"
  body_file="$(mktemp)"

  if ! curl -sS -D "$header_file" -o "$body_file" "$BASE_URL/healthz" >/dev/null; then
    rm -f "$header_file" "$body_file"
    fail "GET /healthz request execution"
  fi

  status="$(get_status_code "$header_file")"
  if [[ "$status" != "200" ]]; then
    echo "Expected 200 got $status for /healthz" >&2
    echo "Headers:" >&2
    redact_headers <"$header_file"
    echo "Body:" >&2
    cat "$body_file"
    rm -f "$header_file" "$body_file"
    fail "GET /healthz"
  fi

  rm -f "$header_file" "$body_file"
}

call_api() {
  local method="$1"
  local path="$2"
  local expect_status="$3"
  local body="${4:-}"
  local jq_filter="${5:-}"
  local header_file body_file status

  header_file="$(mktemp)"
  body_file="$(mktemp)"

  echo "-> $method $path"
  curl_args=(-sS -D "$header_file" -o "$body_file" -X "$method" "$BASE_URL$path" -H "Authorization: Bearer ${E2E_API_KEY}")
  if [[ -n "$body" ]]; then
    curl_args+=(-H "Content-Type: application/json" --data "$body")
  fi

  if ! curl "${curl_args[@]}" >/dev/null; then
    echo "Request execution failed" >&2
    rm -f "$header_file" "$body_file"
    fail "$method $path request"
  fi

  status="$(get_status_code "$header_file")"
  if [[ "$status" != "$expect_status" ]]; then
    echo "Expected $expect_status got $status" >&2
    echo "Headers:" >&2
    redact_headers <"$header_file"
    echo "Body:" >&2
    cat "$body_file"
    rm -f "$header_file" "$body_file"
    fail "$method $path"
  fi

  if [[ -n "$jq_filter" ]]; then
    if ! jq -e "$jq_filter" <"$body_file" >/dev/null 2>&1; then
      echo "Response validation failed: $jq_filter" >&2
      cat "$body_file"
      rm -f "$header_file" "$body_file"
      fail "$method $path validation"
    fi
  fi

  rm -f "$header_file" "$body_file"
}

call_health
call_api "POST" "/v1/memories" 200 '{"user_id":"e2e-user","text":"hello e2e memory","namespace":"e2e"}' '.memory_id'
call_api "POST" "/v1/search" 200 '{"user_id":"e2e-user","namespace":"e2e","query":"hello","top_k":3}' '.results'
call_api "POST" "/v1/context" 200 '{"user_id":"e2e-user","namespace":"e2e","query":"hello"}' '.context_text'
call_api "GET" "/v1/usage/today" 200 "" '.day'

echo "E2E smoke passed."
