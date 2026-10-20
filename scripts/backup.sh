#!/usr/bin/env bash
# Back up NoSignal without stopping it.
#   - tel.db is copied with SQLite's online backup API (consistent even while running)
#   - everything else under DATA_DIR (uploads, TLS CA) is archived with it
# Result: <backup-dir>/tel-<UTC timestamp>.tar.gz (mode 0600). Old ones beyond --keep are deleted.
# Usage: sudo scripts/backup.sh [--prefix DIR] [--out-dir DIR] [--keep N] [--db-only]
# Restore: stop the service, extract the archive into DATA_DIR (same owner), start, check /api/health.
set -euo pipefail
PREFIX=''; OUT=''; KEEP=14; DB_ONLY=false
while (($#)); do
  case "$1" in
    --prefix) PREFIX=${2:?}; shift 2 ;;
    --out-dir) OUT=${2:?}; shift 2 ;;
    --keep) KEEP=${2:?}; shift 2 ;;
    --db-only) DB_ONLY=true; shift ;;
    -h|--help) sed -n 2,10p "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
PREFIX=${PREFIX%/}
APP_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
ENV_FILE="$PREFIX/etc/tel-messenger.env"
[[ -r $ENV_FILE ]] || { echo "Cannot read $ENV_FILE (run as root?) / فایل تنظیمات خوانده نشد" >&2; exit 1; }
DATA_DIR=$(sed -n 's/^DATA_DIR=//p' "$ENV_FILE" | head -1 | tr -d '"')
[[ -n $DATA_DIR && -f $DATA_DIR/tel.db ]] || { echo "No database at ${DATA_DIR:-?}/tel.db" >&2; exit 1; }
OUT=${OUT:-$PREFIX/var/backups/tel-messenger}
mkdir -p "$OUT"; chmod 700 "$OUT"
ts=$(date -u +%Y%m%dT%H%M%SZ)
tmp=$(mktemp -d "$OUT/.work.XXXXXX"); trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/data"
(cd "$APP_DIR" && node -e 'const D=require("better-sqlite3");const d=new D(process.argv[1],{readonly:true});d.backup(process.argv[2]).then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)})' "$DATA_DIR/tel.db" "$tmp/data/tel.db")
if ! $DB_ONLY; then
  tar -C "$DATA_DIR" --exclude=./tel.db --exclude=./tel.db-wal --exclude=./tel.db-shm --exclude=./server.log -cf - . | tar -C "$tmp/data" -xf -
fi
file="$OUT/tel-$ts.tar.gz"
umask 077
tar -C "$tmp/data" -czf "$file" .
echo "Backup written: $file ($(du -h "$file" | cut -f1))"
ls -1t "$OUT"/tel-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f --
