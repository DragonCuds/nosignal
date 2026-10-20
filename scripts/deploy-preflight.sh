#!/usr/bin/env bash
set -uo pipefail

APP_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
ENV_FILE=${1:-"$APP_DIR/.env"}
failures=0
warnings=0

pass() { printf 'PASS  %s\n' "$1"; }
warn() { printf 'WARN  %s\n' "$1"; warnings=$((warnings + 1)); }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }

env_value() {
  local key=$1
  awk -v key="$key" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "$ENV_FILE"
}

for command in node npm psql pg_dump ffmpeg openssl curl; do
  if command -v "$command" >/dev/null 2>&1; then
    pass "$command is installed"
  else
    fail "$command is not installed"
  fi
done

node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)
if [[ $node_major == 24 ]]; then
  pass "Node.js major version is 24"
else
  fail "Node.js 24 is required (found ${node_major:-unknown})"
fi

if [[ ! -f $ENV_FILE ]]; then
  fail "environment file is missing: $ENV_FILE"
  printf '\nPreflight failed with %d error(s) and %d warning(s).\n' "$failures" "$warnings"
  exit 1
fi

env_mode=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || true)
if [[ $env_mode == 600 || $env_mode == 400 || $env_mode == 640 || $env_mode == 440 ]]; then
  pass "environment file permissions do not expose secrets"
else
  fail "environment file mode must be 600, 400, 640, or 440 (found ${env_mode:-unknown})"
fi

database_url=$(env_value DATABASE_URL)
session_secret=$(env_value SESSION_SECRET)
port=$(env_value PORT)
data_dir=$(env_value DATA_DIR)

if [[ $database_url == postgresql://* || $database_url == postgres://* ]]; then
  if [[ $database_url =~ CHANGE_ME|change-me|replace-with ]]; then
    fail "DATABASE_URL still contains a placeholder"
  else
    pass "DATABASE_URL uses the PostgreSQL URL scheme"
  fi
else
  fail "DATABASE_URL must be a PostgreSQL URL"
fi

if (( ${#session_secret} >= 32 )) && [[ ! $session_secret =~ CHANGE_ME|change-me|replace-with ]]; then
  pass "SESSION_SECRET is non-placeholder and at least 32 characters"
else
  fail "SESSION_SECRET must be non-placeholder and at least 32 characters"
fi

if [[ $port =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )); then
  pass "PORT is valid"
else
  fail "PORT must be an integer from 1 through 65535"
fi

if [[ $data_dir == /* ]]; then
  if [[ -d $data_dir && -w $data_dir ]]; then
    pass "DATA_DIR exists and is writable by the current user"
  elif [[ -e $data_dir ]]; then
    fail "DATA_DIR is not a writable directory for the current user"
  else
    fail "DATA_DIR does not exist"
  fi
else
  fail "DATA_DIR must be an absolute path"
fi

if [[ -f $APP_DIR/apps/server/dist/index.js && -f $APP_DIR/apps/web/dist/index.html ]]; then
  pass "server and web production builds exist"
else
  fail "production builds are missing; run npm ci && npm run build"
fi

if [[ -x /usr/bin/ffmpeg && -x /usr/bin/ffprobe ]]; then
  pass "ffmpeg and ffprobe are available at the paths used by media processing"
else
  fail "/usr/bin/ffmpeg and /usr/bin/ffprobe must both be executable"
fi

if command -v ss >/dev/null 2>&1 && [[ $port =~ ^[0-9]+$ ]]; then
  listeners=$(ss -H -ltn "sport = :$port" 2>/dev/null || true)
  if [[ -z $listeners ]]; then
    warn "nothing is currently listening on PORT"
  elif awk '{ print $4 }' <<<"$listeners" | grep -Evq '^(127\.0\.0\.1|\[::1\]):[0-9]+$'; then
    fail "running listener is exposed beyond loopback"
  else
    pass "running listener is restricted to loopback"
  fi
fi

if [[ $port =~ ^[0-9]+$ ]] && curl --silent --fail --max-time 3 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
  pass "local health endpoint responds"
else
  warn "local health endpoint is not responding"
fi

printf '\nPreflight completed with %d error(s) and %d warning(s).\n' "$failures" "$warnings"
(( failures == 0 ))
