#!/bin/sh
# Production-like server on :3070 (self-signed TLS, so cookies are Secure like the real thing).
# Expects a built copy at $RUN/app (server dist + web dist). See README.md.
RUN=${RUN:-/root/pb3-run}
export NODE_ENV=production PORT=3070 DATA_DIR=${DATA_DIR:-/root/tel-dev/data-test/pb3/data} \
  SESSION_SECRET=test-secret-test-secret-test-secret-xx TRUSTED_ORIGINS=https://${BENCH_HOST:-tel.bench.test}:3070 \
  WEBAUTHN_RP_ID=${BENCH_HOST:-tel.bench.test} OPEN_REGISTRATION=1 TLS_MODE=auto TLS_HOSTS=${BENCH_HOST:-tel.bench.test},localhost
mkdir -p "$DATA_DIR"
cd "$RUN/app/apps/server" || exit 1
npx tsx src/migrate.ts >/dev/null 2>&1
exec node dist/index.js
