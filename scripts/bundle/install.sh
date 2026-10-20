#!/usr/bin/env bash
# Offline installer shipped inside the bundle (no network used). Safe to run again = update.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[ "$(id -u)" = 0 ] || { echo "Run as root: sudo ./install.sh"; exit 1; }
APP_DIR="${APP_DIR:-/opt/tel-messenger}"; DATA_DIR="${DATA_DIR:-/var/lib/tel-messenger}"
ENV_FILE="${ENV_FILE:-/etc/tel-messenger.env}"; PORT="${PORT:-3050}"
SVC_USER=tel-messenger   # must match User= in deploy/tel-messenger.service.in

id "$SVC_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$APP_DIR" "$DATA_DIR"
WAS_RUNNING=0; systemctl is-active --quiet tel-messenger 2>/dev/null && WAS_RUNNING=1
[ "$WAS_RUNNING" = 1 ] && systemctl stop tel-messenger
# replace code only; DATA_DIR and ENV_FILE live outside APP_DIR and are never touched
rm -rf "$APP_DIR/apps" "$APP_DIR/packages" "$APP_DIR/node_modules" "$APP_DIR/node" "$APP_DIR/bin"
cp -a "$HERE/app/." "$APP_DIR/"; cp -a "$HERE/node" "$HERE/VERSION" "$APP_DIR/"
[ -d "$HERE/bin" ] && cp -a "$HERE/bin" "$APP_DIR/"
install -m 755 "$HERE/tel-user-add" "$APP_DIR/tel-user-add"
# the server calls /usr/bin/ffmpeg and /usr/bin/ffprobe: link ours only if the system has none
for t in ffmpeg ffprobe; do
  [ -x "$APP_DIR/bin/$t" ] && [ ! -e "/usr/bin/$t" ] && ln -s "$APP_DIR/bin/$t" "/usr/bin/$t" || true
done
chown -R "$SVC_USER": "$DATA_DIR"; chmod 700 "$DATA_DIR"

if [ ! -f "$ENV_FILE" ]; then
  HOST="${HOST_NAME:-$(hostname -I 2>/dev/null | awk '{print $1}')}"; HOST="${HOST:-localhost}"
  sed -e "s|^PORT=.*|PORT=$PORT|" -e "s|^DATA_DIR=.*|DATA_DIR=$DATA_DIR|" \
      -e "s|^SESSION_SECRET=.*|SESSION_SECRET=$(head -c 48 /dev/urandom | base64 -w0)|" \
      -e "s|^TRUSTED_ORIGINS=.*|TRUSTED_ORIGINS=https://$HOST:$PORT|" -e "s|^WEBAUTHN_RP_ID=.*|WEBAUTHN_RP_ID=$HOST|" \
      "$HERE/.env.example" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi
sed -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@DATA_DIR@|$DATA_DIR|g" \
    -e "s|/usr/bin/node|$APP_DIR/node/bin/node|" "$HERE/deploy/tel-messenger.service.in" > /etc/systemd/system/tel-messenger.service
systemctl daemon-reload; systemctl enable --now tel-messenger

# clock check (no network): only a hint, tokens/sessions depend on a sane clock
YEAR="$(date +%Y)"; [ "$YEAR" -ge 2026 ] || echo "WARNING: server clock says year $YEAR. Set the correct date/time (timedatectl set-time) before use."
timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q yes || echo "NOTE: clock is not NTP-synced; make sure date/time is correct (check with: date)."

HOST_SHOW="$(grep -m1 '^TRUSTED_ORIGINS=' "$ENV_FILE" | cut -d= -f2- | cut -d, -f1)"
echo "Installed version $(cat "$HERE/VERSION"). Address: ${HOST_SHOW:-https://localhost:$PORT}"
echo "Create the first (admin) user:  sudo $APP_DIR/tel-user-add <username> \"<display name>\""
echo "Guide: INSTALL-FA.md"
