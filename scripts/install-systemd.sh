#!/usr/bin/env bash
set -euo pipefail

APP_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
APPLY=false
SOURCE_ENV="$APP_DIR/.env"
DATA_DIR=/var/lib/tel-messenger
UNIT_TEMPLATE="$APP_DIR/deploy/tel-messenger.service.in"
UNIT_DEST=/etc/systemd/system/tel-messenger.service
ENV_DEST=/etc/tel-messenger.env

usage() {
  printf 'Usage: %s [--apply] [--env-file PATH] [--data-dir PATH]\n' "$0"
  printf 'Without --apply, validates inputs and prints the staged cutover plan.\n'
}

while (($#)); do
  case "$1" in
    --apply) APPLY=true; shift ;;
    --env-file) SOURCE_ENV=${2:?missing path after --env-file}; shift 2 ;;
    --data-dir) DATA_DIR=${2:?missing path after --data-dir}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

SOURCE_ENV=$(realpath -e -- "$SOURCE_ENV") || { printf '%s\n' 'Environment file does not exist' >&2; exit 1; }
for checked_path in "$APP_DIR" "$SOURCE_ENV" "$DATA_DIR"; do
  [[ $checked_path == /* && $checked_path =~ ^/[A-Za-z0-9._/-]+$ ]] || {
    printf 'Refusing unsafe or non-absolute path: %s\n' "$checked_path" >&2
    exit 1
  }
done
[[ -f $UNIT_TEMPLATE ]] || { printf 'Missing unit template: %s\n' "$UNIT_TEMPLATE" >&2; exit 1; }
[[ -f $SOURCE_ENV ]] || { printf 'Missing source environment file: %s\n' "$SOURCE_ENV" >&2; exit 1; }

printf 'Application: %s\nEnvironment source: %s\nData directory: %s\n' "$APP_DIR" "$SOURCE_ENV" "$DATA_DIR"
if [[ $APPLY != true ]]; then
  printf 'Dry run only. Re-run with --apply as root to stage files; the script will not restart the service.\n'
  exit 0
fi

(( EUID == 0 )) || { printf '%s\n' '--apply must run as root' >&2; exit 1; }
getent passwd tel-messenger >/dev/null || useradd --system --home /var/lib/tel-messenger --shell /usr/sbin/nologin tel-messenger
install -d -o tel-messenger -g tel-messenger -m 0700 "$DATA_DIR"

if [[ -e $ENV_DEST ]]; then
  printf 'Preserving existing %s (secrets were not replaced).\n' "$ENV_DEST"
else
  install -o root -g tel-messenger -m 0640 "$SOURCE_ENV" "$ENV_DEST"
  printf 'Installed environment file at %s.\n' "$ENV_DEST"
fi

tmp_unit=$(mktemp --suffix=.service /tmp/tel-messenger.XXXXXX)
trap 'rm -f -- "$tmp_unit"' EXIT
escaped_app=${APP_DIR//&/\\&}
escaped_data=${DATA_DIR//&/\\&}
sed -e "s|@APP_DIR@|$escaped_app|g" -e "s|@DATA_DIR@|$escaped_data|g" "$UNIT_TEMPLATE" > "$tmp_unit"
systemd-analyze verify "$tmp_unit"
install -o root -g root -m 0644 "$tmp_unit" "$UNIT_DEST"
systemctl daemon-reload

printf '%s\n' 'Unit and permissions are staged; the running service was not restarted.'
printf '%s\n' 'Review /etc/tel-messenger.env, run preflight as tel-messenger, then perform the cutover commands from DEPLOYMENT.md.'
