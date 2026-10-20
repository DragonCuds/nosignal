#!/usr/bin/env bash
# NoSignal - one-command installer / upgrader / uninstaller.
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/nosignal/main/install.sh \
#     | sudo bash -s -- --domain tel.example.com --admin myname
#   sudo ./install.sh --domain tel.example.com --admin myname      (from a cloned repo)
#
# Supported: Ubuntu 22.04 / 24.04, Debian 12 (x86_64, aarch64), run as root.
# Full guide: docs/INSTALL.md   |   راهنمای فارسی: INSTALL-FA.md
set -euo pipefail

REPO_URL_DEFAULT='https://github.com/<owner>/nosignal.git'
NODE_MAJOR=24

# ----------------------------------------------------------------------------- options
DOMAIN=''; IP_ONLY=false; IP_ADDR=''; ADMIN_USER=''; ADMIN_PASS_FILE=''; EMAIL=''
OPEN_SIGNUP=''            # '' = not specified, true/false = explicit
REPO_URL=''; REF=''; SOURCE_TARBALL=''; NODE_TARBALL=''
PREFIX=''; PORT=''
NO_NGINX=false; NO_SYSTEMD=false; NO_PACKAGES=false; NO_CERTBOT=false; SKIP_DNS_CHECK=false
TLS_CERT=''; TLS_KEY=''
DRY_RUN=false; UNINSTALL=false; PURGE=false; UPDATE_ONLY=false; FORCE=false; ASSUME_YES=false

usage() {
  cat <<'EOF'
Usage: install.sh [options]

  --domain NAME           public DNS name (nginx + Let's Encrypt TLS)
  --ip-only [--ip ADDR]   no domain: the app serves its own self-signed HTTPS on port 3050
  --admin NAME            first admin username (a-z 0-9 _ , 3-32 chars)
  --admin-password-file F read the admin password from the first line of F (else generated, printed once)
  --open-signup           anyone may register with ID + password (default: off, invites/CLI only)
  --email ADDR            e-mail for Let's Encrypt expiry notices (optional)

  --repo URL --ref REF    git source (default: the local checkout, else the public GitHub repo)
  --source TARBALL        offline source: .tar.gz/.tar.xz path or URL of the project
  --node-tarball P|URL    Node.js linux tarball (mirror) instead of NodeSource/nodejs.org
  --port N                internal app port (default 3050)

  --cert F --key F        use your own TLS certificate (PEM) with the built-in HTTPS server
  --prefix DIR            install under DIR (test mode; runs as the current user)
  --no-nginx --no-systemd --no-packages --no-certbot --skip-dns-check
  --dry-run               print the plan, change nothing
  --update                upgrade in place using the saved settings (same as re-running)
  --uninstall [--purge]   remove the service/app; data is kept unless --purge
  --force                 continue on unsupported OS / low resources
  -y, --yes               never prompt
  -h, --help
EOF
}

while (($#)); do
  case "$1" in
    --domain) DOMAIN=${2:?--domain needs a value}; shift 2 ;;
    --ip-only) IP_ONLY=true; shift ;;
    --ip) IP_ADDR=${2:?}; shift 2 ;;
    --admin) ADMIN_USER=${2:?}; shift 2 ;;
    --admin-password-file) ADMIN_PASS_FILE=${2:?}; shift 2 ;;
    --open-signup) OPEN_SIGNUP=true; shift ;;
    --no-open-signup) OPEN_SIGNUP=false; shift ;;
    --email) EMAIL=${2:?}; shift 2 ;;
    --repo) REPO_URL=${2:?}; shift 2 ;;
    --ref) REF=${2:?}; shift 2 ;;
    --source) SOURCE_TARBALL=${2:?}; shift 2 ;;
    --node-tarball) NODE_TARBALL=${2:?}; shift 2 ;;
    --port) PORT=${2:?}; shift 2 ;;
    --prefix) PREFIX=${2:?}; shift 2 ;;
    --cert) TLS_CERT=${2:?}; shift 2 ;;
    --key) TLS_KEY=${2:?}; shift 2 ;;
    --no-nginx) NO_NGINX=true; shift ;;
    --no-systemd) NO_SYSTEMD=true; shift ;;
    --no-packages) NO_PACKAGES=true; shift ;;
    --no-certbot) NO_CERTBOT=true; shift ;;
    --skip-dns-check) SKIP_DNS_CHECK=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --update) UPDATE_ONLY=true; shift ;;
    --uninstall) UNINSTALL=true; shift ;;
    --purge) PURGE=true; shift ;;
    --force) FORCE=true; shift ;;
    -y|--yes) ASSUME_YES=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option / گزینه نامعتبر: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

# ----------------------------------------------------------------------------- layout
PREFIX=${PREFIX%/}
APP_DIR="$PREFIX/opt/tel-messenger"
DATA_DIR="$PREFIX/var/lib/tel-messenger"
ENV_FILE="$PREFIX/etc/tel-messenger.env"
STATE_FILE="$PREFIX/etc/tel-messenger.install"
BACKUP_DIR="$PREFIX/var/backups/tel-messenger"
LOG_FILE="$PREFIX/var/log/tel-messenger-install.log"
RUN_DIR="$PREFIX/var/lib/tel-messenger-run"
UNIT_DEST="/etc/systemd/system/tel-messenger.service"
NGINX_CONF="/etc/nginx/conf.d/tel-messenger.conf"
ACME_ROOT="/var/www/tel-acme"
SVC_USER=tel-messenger
[[ -n $PREFIX ]] && SVC_USER=''          # prefix/test mode: run as the invoking user

# stdout copy that is NOT written to the log file (used for the one-time password)
exec 3>&1

# ----------------------------------------------------------------------------- helpers
c_red=''; c_grn=''; c_ylw=''; c_off=''
if [[ -t 1 ]]; then c_red=$'\e[31m'; c_grn=$'\e[32m'; c_ylw=$'\e[33m'; c_off=$'\e[0m'; fi
STEP=0
log()  { printf '%s[%s]%s %s\n' "$c_grn" "$(date +%H:%M:%S)" "$c_off" "$*"; }
step() { STEP=$((STEP + 1)); printf '\n%s== %d. %s ==%s\n' "$c_grn" "$STEP" "$*" "$c_off"; }
warn() { printf '%sWARNING / هشدار:%s %s\n' "$c_ylw" "$c_off" "$*" >&2; }
die()  { # die "English" "فارسی"
  printf '\n%sERROR:%s %s\n%sخطا:%s %s\n' "$c_red" "$c_off" "$1" "$c_red" "$c_off" "${2:-$1}" >&2
  printf 'Log / گزارش: %s\n' "$LOG_FILE" >&2
  exit 1
}
trap 'rc=$?; [[ $rc -ne 0 ]] && printf "\nInstall stopped at step %s (exit %s). Safe to re-run. / نصب متوقف شد؛ دوباره اجرا کنید.\n" "$STEP" "$rc" >&2' EXIT

# run CMD... (printed, skipped under --dry-run)
run() {
  if $DRY_RUN; then printf '[dry-run] %s\n' "$*"; return 0; fi
  log "\$ $*"
  "$@"
}
have() { command -v "$1" >/dev/null 2>&1; }
# write_file PATH MODE [OWNER:GROUP]  (content on stdin)
write_file() {
  local path=$1 mode=$2 owner=${3:-}
  if $DRY_RUN; then printf '[dry-run] write %s (mode %s)\n' "$path" "$mode"; cat >/dev/null; return 0; fi
  mkdir -p "$(dirname "$path")"
  local tmp; tmp=$(mktemp "$path.XXXXXX")
  cat >"$tmp"
  chmod "$mode" "$tmp"
  [[ -n $owner && -z $PREFIX ]] && chown "$owner" "$tmp"
  mv -f "$tmp" "$path"
}
is_tty() { [[ -r /dev/tty && -w /dev/tty ]] && { : </dev/tty; } 2>/dev/null; }
ask() { # ask "prompt" default -> echo answer
  local prompt=$1 default=${2:-} ans=''
  if $ASSUME_YES || ! is_tty; then printf '%s' "$default"; return; fi
  printf '%s%s: ' "$prompt" "${default:+ [$default]}" >/dev/tty
  read -r ans </dev/tty || true
  printf '%s' "${ans:-$default}"
}
rand() { openssl rand -base64 "$1" | tr -d '\n'; }

svc_user_exists() { [[ -z $SVC_USER ]] || getent passwd "$SVC_USER" >/dev/null; }
# with_env CMD... : run in APP_DIR with the service environment, as the service user
with_env() {
  local runner=()
  [[ -n $SVC_USER ]] && runner=(runuser -u "$SVC_USER" --)
  "${runner[@]}" env HOME="$DATA_DIR" NODE_ENV=production PATH="$APP_DIR/node/bin:$APP_DIR/bin:$PATH" \
    bash -c 'set -a; . "$1"; set +a; cd "$2"; shift 2; exec "$@"' _ "$ENV_FILE" "$APP_DIR" "$@"
}
env_get() { [[ -f $ENV_FILE ]] && sed -n "s/^$1=//p" "$ENV_FILE" | head -1 | sed 's/^"\(.*\)"$/\1/' || true; }
env_set() { # env_set KEY VALUE (replace or append, never touches other keys)
  local key=$1 val=$2
  $DRY_RUN && { printf '[dry-run] env %s=...\n' "$key"; return; }
  if grep -q "^$key=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^$key=.*|$key=$val|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >>"$ENV_FILE"
  fi
}

# ----------------------------------------------------------------------------- uninstall
svc_stop() {
  if [[ -f $RUN_DIR/app.pid ]]; then
    local pid; pid=$(cat "$RUN_DIR/app.pid" 2>/dev/null || true)
    if [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done; fi
    rm -f "$RUN_DIR/app.pid"
  fi
  if ! $NO_SYSTEMD && have systemctl && [[ -f $UNIT_DEST ]]; then systemctl stop tel-messenger 2>/dev/null || true; fi
}
svc_start() {
  if $NO_SYSTEMD; then
    mkdir -p "$RUN_DIR"
    with_env_bg
  else
    systemctl start tel-messenger
  fi
}
with_env_bg() {
  local runner=(); [[ -n $SVC_USER ]] && runner=(runuser -u "$SVC_USER" --)
  nohup "${runner[@]}" env HOME="$DATA_DIR" NODE_ENV=production \
    bash -c 'set -a; . "$1"; set +a; cd "$2"; echo $$ > "$3"; exec "$4" apps/server/dist/index.js' _ \
    "$ENV_FILE" "$APP_DIR" "$RUN_DIR/app.pid" "$NODE_BIN" >>"$DATA_DIR/server.log" 2>&1 3>&- </dev/null &
  disown || true
}

if $UNINSTALL; then
  [[ $EUID -eq 0 || -n $PREFIX ]] || die 'Run as root (sudo).' 'با دسترسی root اجرا کنید (sudo).'
  log "Uninstalling (data kept: $([[ $PURGE == true ]] && echo no || echo yes))"
  $DRY_RUN || svc_stop
  if ! $NO_SYSTEMD && have systemctl; then
    run systemctl disable tel-messenger 2>/dev/null || true
    run rm -f "$UNIT_DEST"; run systemctl daemon-reload 2>/dev/null || true
  fi
  if ! $NO_NGINX && [[ -f $NGINX_CONF ]]; then run rm -f "$NGINX_CONF"; have nginx && run systemctl reload nginx || true; fi
  for t in ffmpeg ffprobe; do [[ -L /usr/bin/$t && $(readlink /usr/bin/$t) == "$APP_DIR/bin/$t" ]] && run rm -f /usr/bin/$t; done
  run rm -rf "$APP_DIR" "$APP_DIR.new" "$APP_DIR.prev" "$APP_DIR.failed"
  if $PURGE; then
    run rm -rf "$DATA_DIR"; run rm -f "$ENV_FILE" "$STATE_FILE"
    [[ -n $SVC_USER ]] && getent passwd "$SVC_USER" >/dev/null && run userdel "$SVC_USER" || true
    log "Purged data and settings. Backups in $BACKUP_DIR were kept."
  else
    log "Kept: data $DATA_DIR, settings $ENV_FILE, backups $BACKUP_DIR (use --purge to delete data)."
  fi
  trap - EXIT; exit 0
fi

# ----------------------------------------------------------------------------- logging
if ! $DRY_RUN; then
  mkdir -p "$(dirname "$LOG_FILE")"; : >>"$LOG_FILE"; chmod 600 "$LOG_FILE"
  exec > >(tee -a "$LOG_FILE") 2>&1
fi

# ----------------------------------------------------------------------------- saved state (re-run / update)
if [[ -f $STATE_FILE ]]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE"
  : "${DOMAIN:=${S_DOMAIN:-}}"; : "${PORT:=${S_PORT:-}}"; : "${ADMIN_USER:=${S_ADMIN:-}}"
  [[ -z $REPO_URL && -z $SOURCE_TARBALL && -n ${S_SRC_KIND:-} ]] && case "${S_SRC_KIND}" in
    git) REPO_URL=${S_SRC_VALUE:-} ;; bundle) ;; tar) SOURCE_TARBALL=${S_SRC_VALUE:-} ;; local) LOCAL_SRC_SAVED=${S_SRC_VALUE:-} ;;
  esac
  [[ ${S_MODE:-} == ip && -z $DOMAIN ]] && IP_ONLY=true
  [[ -z $IP_ADDR ]] && IP_ADDR=${S_IP:-}
  [[ ${S_NO_NGINX:-} == true ]] && NO_NGINX=true
  [[ ${S_NO_SYSTEMD:-} == true ]] && NO_SYSTEMD=true
fi
: "${PORT:=3050}"
UPGRADE=false; [[ -d $APP_DIR && -f $ENV_FILE ]] && UPGRADE=true
$UPDATE_ONLY && ! $UPGRADE && die 'Nothing installed yet; run without --update.' 'هنوز نصب نشده؛ بدون --update اجرا کنید.'

# ----------------------------------------------------------------------------- 1. preflight
step 'Checking the system / بررسی سیستم'
[[ $(uname -s) == Linux ]] || die 'Linux only.' 'فقط لینوکس پشتیبانی می‌شود.'
if [[ $EUID -ne 0 && -z $PREFIX ]] && ! $DRY_RUN; then
  die 'Run as root: sudo ./install.sh ...' 'با root اجرا کنید: sudo ./install.sh ...'
fi
ARCH=$(uname -m)
case $ARCH in x86_64|aarch64) ;; *) $FORCE || die "Unsupported CPU architecture: $ARCH (need x86_64 or aarch64)." "معماری پردازنده پشتیبانی نمی‌شود: $ARCH" ;; esac
OS_ID=''; OS_VER=''
if [[ -r /etc/os-release ]]; then OS_ID=$(. /etc/os-release; echo "${ID:-}"); OS_VER=$(. /etc/os-release; echo "${VERSION_ID:-}"); fi
case "$OS_ID:$OS_VER" in
  ubuntu:22.04|ubuntu:24.04|debian:12) log "OS: $OS_ID $OS_VER ($ARCH) ok" ;;
  *) $FORCE || { $NO_PACKAGES && warn "OS $OS_ID $OS_VER is not tested; continuing because of --no-packages." ; } || \
       die "Unsupported OS: $OS_ID $OS_VER. Supported: Ubuntu 22.04/24.04, Debian 12 (use --force to try anyway)." \
           "سیستم‌عامل پشتیبانی نمی‌شود: $OS_ID $OS_VER (اوبونتو ۲۲.۰۴/۲۴.۰۴ یا دبیان ۱۲؛ با --force می‌توانید امتحان کنید)." ;;
esac
RAM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if ((RAM_MB < 700)); then $FORCE || die "Only ${RAM_MB} MB RAM; need at least 1 GB (add swap or use --force)." "فقط ${RAM_MB} مگابایت حافظه دارید؛ حداقل ۱ گیگابایت لازم است."; fi
((RAM_MB < 1024)) && warn "Only ${RAM_MB} MB RAM; the build step may be slow. / حافظه کم است؛ ساخت برنامه کند می‌شود."
CHECK_DIR=$PREFIX; [[ -z $CHECK_DIR ]] && CHECK_DIR=/
while [[ ! -d $CHECK_DIR ]]; do CHECK_DIR=$(dirname "$CHECK_DIR"); done
DISK_MB=$(df -Pm "$CHECK_DIR" | awk 'NR==2 {print $4}')
((DISK_MB >= 2048)) || { $FORCE || die "Only ${DISK_MB} MB free disk; need at least 2 GB." "فقط ${DISK_MB} مگابایت فضای خالی دارید؛ حداقل ۲ گیگابایت لازم است."; }
log "RAM ${RAM_MB} MB, free disk ${DISK_MB} MB ok"
[[ $PORT =~ ^[0-9]+$ ]] && ((PORT >= 1 && PORT <= 65535)) || die "Bad --port: $PORT" "شماره پورت نامعتبر است: $PORT"
if [[ -z $PREFIX && $NO_SYSTEMD == false ]]; then have systemctl && [[ -d /run/systemd/system ]] || die 'systemd not running (use --no-systemd for a manual run).' 'systemd فعال نیست.'; fi

# ----------------------------------------------------------------------------- 2. questions
step 'Settings / تنظیمات'
if [[ -z $DOMAIN && $IP_ONLY == false ]]; then
  if $UPGRADE; then :; else
    DOMAIN=$(ask 'Domain name for this server (empty = IP-only with self-signed HTTPS)' '')
    [[ -z $DOMAIN ]] && IP_ONLY=true
  fi
fi
if [[ -z $DOMAIN ]] && ! $IP_ONLY && ! $UPGRADE; then
  die 'No --domain and not interactive. Pass --domain NAME or --ip-only.' 'دامنه داده نشده. از --domain یا --ip-only استفاده کنید.'
fi
$IP_ONLY && DOMAIN=''
if [[ -n $DOMAIN ]]; then
  DOMAIN=${DOMAIN,,}
  [[ $DOMAIN =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]] || die "Not a valid domain: $DOMAIN" "نام دامنه معتبر نیست: $DOMAIN"
  MODE=domain
else
  MODE=ip
  if [[ -z $IP_ADDR ]]; then
    IP_ADDR=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1 || true)
    [[ -z $IP_ADDR ]] && IP_ADDR=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
    [[ -z $IP_ADDR ]] && IP_ADDR=127.0.0.1
  fi
  [[ $IP_ADDR =~ ^[0-9.]+$ ]] || die "Bad --ip: $IP_ADDR" "آدرس IP نامعتبر است."
fi
if ! $UPGRADE; then
  [[ -z $ADMIN_USER ]] && ADMIN_USER=$(ask 'Admin username' 'admin')
  [[ -z $ADMIN_USER ]] && ADMIN_USER=admin
fi
if [[ -n $ADMIN_USER ]]; then
  [[ $ADMIN_USER =~ ^[a-z0-9_]{3,32}$ ]] || die "Admin username must be 3-32 chars of a-z 0-9 _ : $ADMIN_USER" "نام کاربری مدیر باید ۳ تا ۳۲ حرف انگلیسی کوچک/عدد/_ باشد."
fi
ADMIN_PASS=''; ADMIN_PASS_GENERATED=false
if [[ -n $ADMIN_PASS_FILE ]]; then
  [[ -r $ADMIN_PASS_FILE ]] || die "Cannot read $ADMIN_PASS_FILE" "فایل رمز خوانده نشد: $ADMIN_PASS_FILE"
  ADMIN_PASS=$(head -n1 "$ADMIN_PASS_FILE")
  ((${#ADMIN_PASS} >= 8)) || die 'Admin password must be at least 8 characters.' 'رمز مدیر باید حداقل ۸ حرف باشد.'
fi
if [[ $MODE == domain ]]; then ORIGIN="https://$DOMAIN"; RP_ID=$DOMAIN; HEALTH_URL="http://127.0.0.1:$PORT/api/health"
else ORIGIN="https://$IP_ADDR:$PORT"; RP_ID=$IP_ADDR; HEALTH_URL="https://127.0.0.1:$PORT/api/health"; fi

# source selection
SCRIPT_DIR=''
if [[ -n ${BASH_SOURCE[0]:-} && -f ${BASH_SOURCE[0]} ]]; then SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P); fi
SRC_KIND=''; SRC_VALUE=''
if [[ -n $SOURCE_TARBALL ]]; then SRC_KIND=tar; SRC_VALUE=$SOURCE_TARBALL
elif [[ -n $REPO_URL ]]; then SRC_KIND=git; SRC_VALUE=$REPO_URL
elif [[ -n ${LOCAL_SRC_SAVED:-} && -f ${LOCAL_SRC_SAVED:-/nonexistent}/package.json ]]; then SRC_KIND=local; SRC_VALUE=$LOCAL_SRC_SAVED
elif [[ -n $SCRIPT_DIR && -f $SCRIPT_DIR/.release-bundle && -f $SCRIPT_DIR/apps/server/dist/index.js ]]; then SRC_KIND=bundle; SRC_VALUE=$SCRIPT_DIR
elif [[ -n $SCRIPT_DIR && -f $SCRIPT_DIR/package.json && -d $SCRIPT_DIR/apps/server ]]; then SRC_KIND=local; SRC_VALUE=$SCRIPT_DIR
else SRC_KIND=git; SRC_VALUE=$REPO_URL_DEFAULT; fi
# a tarball that is a release bundle is handled as a bundle directory
if [[ $SRC_KIND == tar ]] && ! $DRY_RUN; then
  EARLY=$(mktemp -d); f=$SRC_VALUE
  if [[ $f =~ ^https?:// ]]; then curl -fsSL "$f" -o "$EARLY/src.tar" || die "Download failed: $f" "دانلود شکست خورد: $f"; f=$EARLY/src.tar; fi
  [[ -f $f ]] || die "Source tarball not found: $f" "فایل سورس پیدا نشد: $f"
  mkdir "$EARLY/x"; tar -xf "$f" -C "$EARLY/x"
  top=$(find "$EARLY/x" -maxdepth 2 -name .release-bundle | head -1)
  if [[ -n $top ]]; then SRC_KIND=bundle; SRC_VALUE=$(dirname "$top"); else SRC_KIND=tar; SRC_VALUE=$f; fi
fi
if [[ $SRC_KIND == bundle && ${S_SRC_KIND:-} == bundle && -z $SOURCE_TARBALL && $SCRIPT_DIR == "$APP_DIR" ]]; then
  die 'This is an installed copy. To update, give the new release file: scripts/update.sh --source tel-messenger-NEW-full.tar.gz' \
      'برای به‌روزرسانی فایل نسخه‌ی جدید را بدهید: scripts/update.sh --source فایل.tar.gz'
fi
FULL=false; SELF_TLS=false
if [[ $SRC_KIND == bundle && -x $SRC_VALUE/node/bin/node && -x $SRC_VALUE/bin/ffmpeg ]]; then
  FULL=true; NO_NGINX=true; NO_CERTBOT=true; NO_PACKAGES=true
  export PATH="$SRC_VALUE/node/bin:$PATH"
fi
if [[ $MODE == ip || $FULL == true || -n $TLS_CERT ]]; then SELF_TLS=true; fi
[[ -n $TLS_CERT || -n $TLS_KEY ]] && { [[ -r $TLS_CERT && -r $TLS_KEY ]] || die '--cert and --key must both be readable PEM files.' '--cert و --key هر دو باید فایل PEM قابل‌خواندن باشند.'; }
if $FULL && [[ $MODE == ip && -z $IP_ADDR ]]; then :; fi
PORT_SUFFIX=":$PORT"; [[ $PORT == 443 ]] && PORT_SUFFIX=''
if $SELF_TLS; then
  HEALTH_URL="https://127.0.0.1:$PORT/api/health"
  [[ $MODE == domain ]] && ORIGIN="https://$DOMAIN$PORT_SUFFIX" || ORIGIN="https://$IP_ADDR$PORT_SUFFIX"
fi
if $FULL; then NODE_BIN="$APP_DIR/node/bin/node"; else NODE_BIN=$(command -v node 2>/dev/null || echo /usr/bin/node); fi
if [[ $SRC_KIND == git && $SRC_VALUE == *'<owner>'* ]]; then
  die 'Replace <owner> in the repo URL: pass --repo https://github.com/OWNER/nosignal.git (or run from a cloned checkout).' \
      'آدرس مخزن را با --repo بدهید (یا از داخل پوشه‌ی دانلودشده اجرا کنید).'
fi

cat <<EOF
Plan:
  mode            : $MODE ($([[ $MODE == domain ]] && echo "$DOMAIN, nginx + Let's Encrypt" || echo "https://$IP_ADDR:$PORT, built-in self-signed HTTPS"))
  action          : $($UPGRADE && echo upgrade-in-place || echo fresh install)
  source          : $SRC_KIND $SRC_VALUE
  app / data / env: $APP_DIR , $DATA_DIR , $ENV_FILE
  admin           : ${ADMIN_USER:-(existing)}   open signup: ${OPEN_SIGNUP:-keep/off}
  nginx/systemd   : $([[ $NO_NGINX == true || $MODE == ip ]] && echo no || echo yes) / $($NO_SYSTEMD && echo no || echo yes)
EOF

# ----------------------------------------------------------------------------- 3. DNS check (domain mode)
if [[ $MODE == domain ]] && ! $SELF_TLS && ! $NO_CERTBOT && ! $NO_NGINX && ! $SKIP_DNS_CHECK && ! $UPGRADE; then
  step "Checking DNS for $DOMAIN / بررسی DNS"
  RESOLVED=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)
  [[ -n $RESOLVED ]] || die "$DOMAIN does not resolve. Create an A record pointing to this server's public IP, wait a few minutes, re-run. (--skip-dns-check to override)" \
                           "دامنه $DOMAIN هنوز به جایی اشاره نمی‌کند. یک رکورد A به IP عمومی این سرور بسازید، چند دقیقه صبر کنید و دوباره اجرا کنید."
  LOCAL_IPS=$(ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | tr '\n' ' ' || true)
  PUBLIC_IP=$(curl -fsS --max-time 6 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 6 https://ifconfig.me 2>/dev/null || true)
  OKDNS=false
  for r in $RESOLVED; do
    [[ " $LOCAL_IPS " == *" $r "* || ( -n $PUBLIC_IP && $r == "$PUBLIC_IP" ) ]] && OKDNS=true
  done
  $OKDNS || die "$DOMAIN points to [${RESOLVED% }] but this server is [${PUBLIC_IP:-unknown}${LOCAL_IPS:+ / ${LOCAL_IPS% }}]. Fix the A record, wait for DNS, re-run (or --skip-dns-check)." \
               "دامنه $DOMAIN به [${RESOLVED% }] اشاره می‌کند ولی IP این سرور [${PUBLIC_IP:-نامشخص}] است. رکورد A را درست کنید و دوباره اجرا کنید."
  log "DNS ok: $DOMAIN -> ${RESOLVED% }"
fi

# ----------------------------------------------------------------------------- 4. packages & Node
apt_install() { run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"; }
node_major() { have node && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

install_node_tarball() { # P|URL
  local src=$1 tmp name na
  tmp=$(mktemp -d); case $ARCH in x86_64) na=x64 ;; *) na=arm64 ;; esac
  if [[ -z $src ]]; then
    log 'Downloading Node.js from nodejs.org'
    local base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
    curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
    name=$(grep "linux-$na.tar.xz" "$tmp/SHASUMS256.txt" | awk '{print $2}' | head -1)
    [[ -n $name ]] || die 'Could not find a Node.js tarball name.' 'نام فایل Node.js پیدا نشد.'
    curl -fsSL "$base/$name" -o "$tmp/$name"
    (cd "$tmp" && grep " $name\$" SHASUMS256.txt | sha256sum -c -) || die 'Node.js checksum mismatch.' 'جمع‌کنترلی Node.js نادرست است.'
    src=$tmp/$name
  elif [[ $src =~ ^https?:// ]]; then
    curl -fsSL "$src" -o "$tmp/node.tar.xz"; src=$tmp/node.tar.xz
  fi
  [[ -f $src ]] || die "Node tarball not found: $src" "فایل Node.js پیدا نشد: $src"
  mkdir -p /usr/local/lib/nodejs
  rm -rf /usr/local/lib/nodejs/current.new; mkdir /usr/local/lib/nodejs/current.new
  tar -xf "$src" -C /usr/local/lib/nodejs/current.new --strip-components=1
  rm -rf /usr/local/lib/nodejs/current; mv /usr/local/lib/nodejs/current.new /usr/local/lib/nodejs/current
  for b in node npm npx corepack; do [[ -e /usr/local/lib/nodejs/current/bin/$b ]] && ln -sf "/usr/local/lib/nodejs/current/bin/$b" "/usr/local/bin/$b"; done
  rm -rf "$tmp"; hash -r
}

step 'Packages and Node.js / بسته‌ها و Node.js'
$FULL || log "OS packages this installer needs: Node.js $NODE_MAJOR, ffmpeg (+ffprobe), openssl, curl$([[ $MODE == domain && $NO_NGINX == false ]] && echo ', nginx, certbot')$([[ $SRC_KIND == git ]] && echo ', git')."
$FULL || log 'On a server without international internet, pre-install them (apt mirror) and pass --node-tarball for Node. / روی سرور بدون اینترنت بین‌الملل، این بسته‌ها را از آینه‌ی apt نصب کنید و برای Node از --node-tarball استفاده کنید.'
if $FULL; then
  log 'FULLY OFFLINE bundle: Node.js and ffmpeg come from the bundle; no apt, npm, git, curl or nginx is used; system packages are not touched. / بسته‌ی کاملاً آفلاین: هیچ بسته‌ی سیستمی نصب یا تغییر نمی‌کند.'
  have openssl || die 'openssl is needed for the built-in HTTPS certificate (apt install openssl).' 'برای ساخت گواهی HTTPS به openssl نیاز است.'
elif $NO_PACKAGES; then
  log 'Skipping package installation (--no-packages); only verifying.'
else
  have apt-get || die 'apt-get not found (Debian/Ubuntu only).' 'apt-get پیدا نشد.'
  run apt-get update -y
  PKGS=(ca-certificates curl tar xz-utils openssl ffmpeg)
  [[ $SRC_KIND == git ]] && PKGS+=(git)
  [[ $SRC_KIND == bundle ]] && have ffmpeg && have ffprobe && PKGS=("${PKGS[@]/ffmpeg}")
  [[ $MODE == domain && $NO_NGINX == false ]] && PKGS+=(nginx)
  [[ $MODE == domain && $NO_NGINX == false && $NO_CERTBOT == false ]] && PKGS+=(certbot)
  apt_install "${PKGS[@]}"
  if (( $(node_major) < NODE_MAJOR )); then
    if [[ -n $NODE_TARBALL ]]; then
      log "Installing Node.js from tarball $NODE_TARBALL"; $DRY_RUN || install_node_tarball "$NODE_TARBALL"
    elif $DRY_RUN; then printf '[dry-run] install Node %s via NodeSource, fallback nodejs.org tarball\n' "$NODE_MAJOR"
    else
      log "Installing Node.js $NODE_MAJOR via NodeSource"
      if curl -fsSL --max-time 60 "https://deb.nodesource.com/setup_$NODE_MAJOR.x" -o /tmp/nodesource_setup.sh \
         && bash /tmp/nodesource_setup.sh && DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs; then
        rm -f /tmp/nodesource_setup.sh
      else
        warn 'NodeSource unreachable; falling back to the nodejs.org tarball. / NodeSource در دسترس نیست؛ از nodejs.org می‌گیرم.'
        install_node_tarball '' || die "Could not install Node.js. Download the linux tarball elsewhere and pass --node-tarball /path/node-v$NODE_MAJOR.x-linux-x64.tar.xz" \
                                      "نصب Node.js ممکن نشد. فایل tar را از یک آینه بگیرید و با --node-tarball بدهید."
      fi
    fi
  fi
fi
if ! $DRY_RUN; then
  (( $(node_major) >= NODE_MAJOR )) || die "Node.js $NODE_MAJOR or newer is required (found $(node -v 2>/dev/null || echo none))." "Node.js نسخه $NODE_MAJOR یا بالاتر لازم است."
  $FULL || have ffmpeg && have ffprobe || $FULL || die 'ffmpeg/ffprobe missing (apt install ffmpeg).' 'ffmpeg نصب نیست.'
  have openssl || die 'openssl missing.' 'openssl نصب نیست.'
  log "Node $(node -v), $(ffmpeg -version | head -1 | cut -d' ' -f1-3)"
fi

# ----------------------------------------------------------------------------- 5. user, dirs
step 'Service user and folders / کاربر و پوشه‌ها'
if [[ -n $SVC_USER ]] && ! getent passwd "$SVC_USER" >/dev/null; then
  run useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
fi
if ! $DRY_RUN; then
  mkdir -p "$PREFIX/etc" "$BACKUP_DIR" "$RUN_DIR"
  chmod 700 "$BACKUP_DIR"
  if [[ -n $SVC_USER ]]; then install -d -o "$SVC_USER" -g "$SVC_USER" -m 0700 "$DATA_DIR"; else install -d -m 0700 "$DATA_DIR"; fi
  [[ -n $SVC_USER ]] && chown "$SVC_USER" "$RUN_DIR"
fi

# ----------------------------------------------------------------------------- 6. fetch + build into APP_DIR.new
fetch_source() {
  local stage=$1
  rm -rf "$stage"; mkdir -p "$stage"
  case $SRC_KIND in
    bundle)
      log "Using prebuilt release bundle $SRC_VALUE (no git, no npm)"
      [[ $(cat "$SRC_VALUE/.release-bundle") == "linux-$ARCH" ]] || die "This bundle is for $(cat "$SRC_VALUE/.release-bundle"), this machine is linux-$ARCH." "این بسته برای معماری دیگری ساخته شده است."
      if [[ -f $SRC_VALUE/SHA256SUMS ]]; then (cd "$SRC_VALUE" && sha256sum --quiet -c SHA256SUMS) || die 'Bundle files are damaged (SHA256SUMS mismatch). Re-copy the file.' 'فایل‌های بسته آسیب دیده‌اند؛ دوباره کپی کنید.'; log 'Bundle checksums ok'; fi
      cp -a "$SRC_VALUE/." "$stage/" ;;
    local)
      log "Copying local checkout $SRC_VALUE"
      tar -C "$SRC_VALUE" --exclude=./node_modules --exclude=./.git --exclude=./data --exclude=./data-test --exclude=./shots \
          --exclude=./.env --exclude=./.agents --exclude='*/node_modules' --exclude='*/dist' --exclude='*/tsconfig.tsbuildinfo' -cf - . | tar -C "$stage" -xf - || { [[ ${PIPESTATUS[0]} -le 1 && ${PIPESTATUS[1]} -eq 0 ]] || die 'Copying the source failed.' 'کپی سورس شکست خورد.'; } ;;
    git)
      log "Cloning $SRC_VALUE ${REF:+($REF)}"
      git clone --depth 1 ${REF:+--branch "$REF"} "$SRC_VALUE" "$stage" >/dev/null 2>&1 || die "git clone failed: $SRC_VALUE" "دریافت کد با git شکست خورد: $SRC_VALUE"
      GIT_REV=$(git -C "$stage" rev-parse --short HEAD 2>/dev/null || true); rm -rf "$stage/.git" ;;
    tar)
      local f=$SRC_VALUE tmpd
      tmpd=$(mktemp -d)
      if [[ $f =~ ^https?:// ]]; then curl -fsSL "$f" -o "$tmpd/src.tar" || die "Download failed: $f" "دانلود شکست خورد: $f"; f=$tmpd/src.tar; fi
      [[ -f $f ]] || die "Source tarball not found: $f" "فایل سورس پیدا نشد: $f"
      mkdir "$tmpd/x"; tar -xf "$f" -C "$tmpd/x"
      local top; top=$(find "$tmpd/x" -maxdepth 2 -name package.json -path '*/package.json' -not -path '*/node_modules/*' | head -1)
      [[ -n $top ]] || die 'package.json not found in the source tarball.' 'package.json در فایل سورس نیست.'
      cp -a "$(dirname "$top")/." "$stage/"; rm -rf "$tmpd" ;;
  esac
  [[ -f $stage/apps/server/package.json ]] || die 'Source tree looks wrong (apps/server missing).' 'ساختار سورس درست نیست.'
}
npm_build() {
  local dir=$1
  log 'npm ci (installs dependencies; may take a few minutes)'
  if ! (cd "$dir" && npm ci --no-audit --no-fund 2>&1 | tail -n 5); then
    warn 'npm ci failed; installing build tools for native modules and retrying. / ابزار ساخت را نصب می‌کنم و دوباره تلاش می‌کنم.'
    $NO_PACKAGES && die 'npm ci failed (build tools may be needed: build-essential python3).' 'npm ci شکست خورد.'
    apt_install build-essential python3
    (cd "$dir" && npm ci --no-audit --no-fund 2>&1 | tail -n 5) || die 'npm ci failed even with build tools. If this box has no international internet use --source with a bundle that includes node_modules or a npm mirror (npm config set registry ...).' \
        'نصب وابستگی‌ها شکست خورد؛ اگر اینترنت بین‌الملل ندارید از آینه‌ی npm استفاده کنید.'
  fi
  log 'npm run build (shared packages first, then server and web)'
  # `npm run build --workspaces` builds apps/* before packages/*; web needs packages/*/dist, so build those first.
  local pk
  for pk in "$dir"/packages/*/package.json; do
    [[ -f $pk ]] || continue
    (cd "$dir" && npm run build --workspace="$(node -p 'require(process.argv[1]).name' "$pk")" >"$dir/.build.log" 2>&1) \
      || { tail -n 25 "$dir/.build.log"; die 'Build of a shared package failed (output above).' 'ساخت بسته‌های مشترک شکست خورد.'; }
  done
  (cd "$dir" && npm run build >"$dir/.build.log" 2>&1) || { tail -n 25 "$dir/.build.log"; die 'Build failed (output above).' 'ساخت برنامه شکست خورد (خروجی بالا).'; }
  rm -f "$dir/.build.log"
  [[ -f $dir/apps/server/dist/index.js && -f $dir/apps/web/dist/index.html ]] || die 'Build output missing.' 'خروجی ساخت پیدا نشد.'
}
db_backup() { # db_backup DESTFILE : consistent SQLite copy via the backup API
  local dest=$1
  [[ -f $DATA_DIR/tel.db ]] || return 1
  (cd "$APP_DIR" && node -e 'const D=require("better-sqlite3");const d=new D(process.argv[1],{readonly:true});d.backup(process.argv[2]).then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)})' "$DATA_DIR/tel.db" "$dest")
  chmod 600 "$dest"
}

step 'Fetching and building the code / دریافت و ساخت کد'
GIT_REV=''
STAGE="$APP_DIR.new"
if $DRY_RUN; then printf '[dry-run] fetch %s %s -> %s ; npm ci ; npm run build\n' "$SRC_KIND" "$SRC_VALUE" "$STAGE"
else
  fetch_source "$STAGE"
  if [[ $SRC_KIND == bundle ]]; then log 'Prebuilt bundle: skipping npm ci / build.'; else npm_build "$STAGE"; fi
fi

# ----------------------------------------------------------------------------- 7. env file
step 'Settings file / فایل تنظیمات'
CREATE_ENV=false; [[ -f $ENV_FILE ]] || CREATE_ENV=true
ETC_TLS="$PREFIX/etc/tel-messenger-tls"
if [[ -n $TLS_CERT ]] && ! $DRY_RUN; then
  mkdir -p "$ETC_TLS"; install -m 0644 "$TLS_CERT" "$ETC_TLS/cert.pem"; install -m 0640 "$TLS_KEY" "$ETC_TLS/key.pem"
  [[ -n $SVC_USER ]] && chgrp "$SVC_USER" "$ETC_TLS/key.pem" "$ETC_TLS"; chmod 755 "$ETC_TLS"
fi
if $CREATE_ENV; then
  SECRET=$(rand 48)
  write_file "$ENV_FILE" 0640 "root:${SVC_USER:-root}" <<EOF
# Generated by install.sh on $(date -u +%FT%TZ). Contains secrets: never commit or share.
NODE_ENV=production
PORT=$PORT
DATA_DIR=$DATA_DIR
SESSION_SECRET=$SECRET
TRUSTED_ORIGINS=$ORIGIN
WEBAUTHN_RP_ID=$RP_ID
WEBAUTHN_RP_NAME="NoSignal"
OPEN_REGISTRATION=$([[ $OPEN_SIGNUP == true ]] && echo 1 || echo 0)
$(if [[ -n $TLS_CERT ]]; then printf 'TLS_MODE=files\nTLS_CERT_FILE=%s\nTLS_KEY_FILE=%s\nBIND_HOST=0.0.0.0\n' "$ETC_TLS/cert.pem" "$ETC_TLS/key.pem"
elif $SELF_TLS; then printf 'TLS_MODE=auto\nTLS_HOSTS=%s\nBIND_HOST=0.0.0.0\n' "${DOMAIN:-$IP_ADDR}"; else printf 'TLS_MODE=off\nBIND_HOST=127.0.0.1\n'; fi)
EOF
  unset SECRET
  log "Created $ENV_FILE with a new random SESSION_SECRET (mode 0640)."
else
  log "Keeping existing $ENV_FILE (secrets untouched)."
  [[ $OPEN_SIGNUP == true ]] && env_set OPEN_REGISTRATION 1
  [[ $OPEN_SIGNUP == false ]] && env_set OPEN_REGISTRATION 0
  # read the real values back so nginx/health use what the service uses
  PORT=$(env_get PORT); PORT=${PORT:-3050}
  DATA_DIR_ENV=$(env_get DATA_DIR); [[ -n $DATA_DIR_ENV ]] && DATA_DIR=$DATA_DIR_ENV
fi
$DRY_RUN || [[ -z $SVC_USER ]] || chown -R "$SVC_USER":"$SVC_USER" "$DATA_DIR" 2>/dev/null || true

# ----------------------------------------------------------------------------- 8. swap in new code (with backup + rollback)
step 'Installing the new version / نصب نسخه‌ی جدید'
BACKUP_FILE=''
health_wait() {
  local i
  for i in $(seq 1 60); do
    if "$NODE_BIN" -e 'const u=process.argv[1];require(u.startsWith("https")?"https":"http").get(u,{rejectUnauthorized:false,timeout:3000},r=>{let b="";r.on("data",d=>b+=d);r.on("end",()=>process.exit(b.includes("\"ok\":true")?0:1))}).on("error",()=>process.exit(1))' "$HEALTH_URL" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}
write_unit() {
  [[ $NO_SYSTEMD == true ]] && return 0
  local tpl="$STAGE/deploy/tel-messenger.service.in" node_bin
  node_bin=$NODE_BIN
  $DRY_RUN && { printf '[dry-run] install systemd unit -> %s\n' "$UNIT_DEST"; return; }
  [[ -f $tpl ]] || tpl="$APP_DIR/deploy/tel-messenger.service.in"
  sed -e "s|@APP_DIR@|${APP_DIR//&/\\&}|g" -e "s|@DATA_DIR@|${DATA_DIR//&/\\&}|g" -e "s|^ExecStart=/usr/bin/node|ExecStart=$node_bin|" "$tpl" >"$UNIT_DEST.tmp"
  if (( PORT < 1024 )); then sed -i -e 's/^CapabilityBoundingSet=.*/CapabilityBoundingSet=CAP_NET_BIND_SERVICE/' -e 's/^AmbientCapabilities=.*/AmbientCapabilities=CAP_NET_BIND_SERVICE/' "$UNIT_DEST.tmp"; fi
  have systemd-analyze && { systemd-analyze verify "$UNIT_DEST.tmp" 2>&1 | grep -v "^$" | head -5 || true; }
  chmod 644 "$UNIT_DEST.tmp"; mv -f "$UNIT_DEST.tmp" "$UNIT_DEST"
  systemctl daemon-reload; systemctl enable tel-messenger >/dev/null 2>&1
}

if $DRY_RUN; then
  printf '[dry-run] backup tel.db to %s ; stop service ; swap %s ; migrate ; start ; wait for %s ; rollback on failure\n' "$BACKUP_DIR" "$APP_DIR" "$HEALTH_URL"
else
  if $UPGRADE && [[ -f $DATA_DIR/tel.db ]]; then
    BACKUP_FILE="$BACKUP_DIR/tel-pre-update-$(date -u +%Y%m%dT%H%M%SZ).db"
    db_backup "$BACKUP_FILE" || die 'Could not back up tel.db; refusing to upgrade.' 'پشتیبان‌گیری از tel.db ممکن نشد؛ ارتقا انجام نمی‌شود.'
    log "Database backup: $BACKUP_FILE"
  fi
  svc_stop
  rm -rf "$APP_DIR.prev" "$APP_DIR.failed"
  [[ -d $APP_DIR ]] && mv "$APP_DIR" "$APP_DIR.prev"
  mkdir -p "$(dirname "$APP_DIR")"
  mv "$STAGE" "$APP_DIR"
  [[ -n $GIT_REV ]] && echo "$GIT_REV" >"$APP_DIR/.revision"
  write_unit
  if $FULL && [[ -z $PREFIX ]]; then
    for t in ffmpeg ffprobe; do
      if [[ -e /usr/bin/$t ]] && [[ ! -L /usr/bin/$t || $(readlink /usr/bin/$t) != "$APP_DIR/bin/$t" ]]; then log "/usr/bin/$t already exists (system copy kept; the app calls that path)."
      else ln -sf "$APP_DIR/bin/$t" "/usr/bin/$t"; log "Linked /usr/bin/$t -> $APP_DIR/bin/$t (the app calls /usr/bin/$t)"; fi
    done
  fi

  rollback() {
    warn "New version failed ($1). Rolling back. / نسخه‌ی جدید کار نکرد؛ برمی‌گردم به نسخه‌ی قبلی."
    svc_stop
    rm -rf "$APP_DIR.failed"; mv "$APP_DIR" "$APP_DIR.failed"
    if [[ -d $APP_DIR.prev ]]; then
      mv "$APP_DIR.prev" "$APP_DIR"
      [[ -n $BACKUP_FILE && -f $BACKUP_FILE ]] && { rm -f "$DATA_DIR"/tel.db "$DATA_DIR"/tel.db-wal "$DATA_DIR"/tel.db-shm; cp "$BACKUP_FILE" "$DATA_DIR/tel.db"; [[ -n $SVC_USER ]] && chown "$SVC_USER":"$SVC_USER" "$DATA_DIR/tel.db"; chmod 600 "$DATA_DIR/tel.db"; }
      svc_start
      if health_wait; then die "Upgrade failed ($1); the previous version is running again and the database was restored. Failed build kept in $APP_DIR.failed." \
                              "ارتقا شکست خورد ($1)؛ نسخه‌ی قبلی دوباره اجرا شد و پایگاه‌داده برگردانده شد."; fi
      die "Upgrade AND rollback failed. Database backup: $BACKUP_FILE ; previous code is in $APP_DIR ; see journalctl -u tel-messenger." \
          "ارتقا و بازگشت هر دو شکست خوردند. پشتیبان: $BACKUP_FILE"
    fi
    die "Install failed ($1); nothing to roll back to. See logs." "نصب شکست خورد ($1)."
  }

  log 'Running database migrations'
  with_env node apps/server/dist/migrate.js 2>&1 | tail -n 5 && [[ ${PIPESTATUS[0]} -eq 0 ]] || rollback 'migration error'

  # ------------------------------------------------------------------------- 9. admin (first install only)
  HAS_ADMIN=$(with_env node -e 'const D=require("better-sqlite3");const d=new D(process.env.DATA_DIR+"/tel.db",{readonly:true});console.log(d.prepare("SELECT COUNT(*) c FROM users WHERE is_admin=1").get().c)' 2>/dev/null || echo 0)
  if [[ $HAS_ADMIN == 0 ]]; then
    if [[ -z $ADMIN_PASS ]]; then ADMIN_PASS=$(rand 18 | tr -d '/+=' | cut -c1-20); ADMIN_PASS_GENERATED=true; fi
    log "Creating the first admin '$ADMIN_USER'"
    printf '%s\n' "$ADMIN_PASS" | with_env node apps/server/dist/cli/user-add.js "$ADMIN_USER" "$ADMIN_USER" --admin 2>&1 | tail -n 3
    [[ ${PIPESTATUS[1]} -eq 0 ]] || rollback 'could not create the admin'
    ADMIN_CREATED=true
  else
    log 'An admin already exists; not creating another.'
    ADMIN_CREATED=false
  fi

  # ------------------------------------------------------------------------- 10. start + health
  log 'Starting the service'
  svc_start
  health_wait || { $NO_SYSTEMD || journalctl -u tel-messenger -n 15 --no-pager 2>/dev/null || tail -n 15 "$DATA_DIR/server.log" 2>/dev/null || true; rollback "health check on $HEALTH_URL"; }
  log "Healthy: $HEALTH_URL"
  rm -rf "$APP_DIR.prev"
fi

# ----------------------------------------------------------------------------- 11. nginx + TLS (domain mode)
nginx_site() { # nginx_site with_tls
  local tls=$1
  local proxy_block
  proxy_block=$(cat <<EOF
    client_max_body_size 64m;
    # The app compresses what is safe to compress itself; ciphertext must not be gzip'd by nginx.
    gzip off;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
    proxy_request_buffering off;
    location /ws {
      proxy_pass http://127.0.0.1:$PORT;
      proxy_set_header Upgrade \$http_upgrade;
      proxy_set_header Connection \$connection_upgrade;
      proxy_read_timeout 3600s;
    }
    location / { proxy_pass http://127.0.0.1:$PORT; }
EOF
)
  cat <<EOF
# Managed by tel-messenger install.sh
map \$http_upgrade \$connection_upgrade { default upgrade; '' close; }
server {
  listen 80;
  listen [::]:80;
  server_name $DOMAIN;
  location /.well-known/acme-challenge/ { root $ACME_ROOT; }
$(if [[ $tls == true ]]; then echo '  location / { return 301 https://$host$request_uri; }'; else echo "$proxy_block"; fi)
}
$(if [[ $tls == true ]]; then cat <<EOT
server {
  listen 443 ssl http2;
  listen [::]:443 ssl http2;
  server_name $DOMAIN;
  ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_session_cache shared:tel:10m;
$proxy_block
}
EOT
fi)
EOF
}

if [[ $MODE == domain && $NO_NGINX == false ]]; then
  step "nginx and TLS for $DOMAIN / nginx و گواهی TLS"
  if $DRY_RUN; then
    printf '[dry-run] write %s ; certbot certonly --webroot -w %s -d %s ; rewrite site with TLS ; reload nginx\n' "$NGINX_CONF" "$ACME_ROOT" "$DOMAIN"
  else
    mkdir -p "$ACME_ROOT"
    HAVE_CERT=false; [[ -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem ]] && HAVE_CERT=true
    if ! $HAVE_CERT; then
      nginx_site false | write_file "$NGINX_CONF" 0644
      nginx -t 2>&1 || die 'nginx config test failed.' 'تست تنظیمات nginx شکست خورد.'
      systemctl enable --now nginx >/dev/null 2>&1 || true; systemctl reload nginx
      if $NO_CERTBOT; then warn "--no-certbot: serving plain HTTP on port 80 only; add TLS yourself (origin is $ORIGIN)."
      else
        have certbot || die 'certbot not installed.' 'certbot نصب نیست.'
        log "Requesting a Let's Encrypt certificate"
        certbot certonly --webroot -w "$ACME_ROOT" -d "$DOMAIN" --non-interactive --agree-tos \
          ${EMAIL:+-m "$EMAIL"} ${EMAIL:---register-unsafely-without-email} --deploy-hook 'systemctl reload nginx' 2>&1 | tail -n 8 \
          && [[ ${PIPESTATUS[0]} -eq 0 ]] || die "certbot failed. Check: DNS A record of $DOMAIN -> this server, ports 80 and 443 open in the firewall/cloud panel, then re-run. (Let's Encrypt limits: 5 failures/hour.)" \
                                                   "certbot شکست خورد. رکورد A دامنه و باز بودن پورت‌های ۸۰ و ۴۴۳ (فایروال/پنل سرویس‌دهنده) را بررسی کنید و دوباره اجرا کنید."
        HAVE_CERT=true
      fi
    fi
    if $HAVE_CERT; then
      nginx_site true | write_file "$NGINX_CONF" 0644
      nginx -t 2>&1 || die 'nginx config test failed.' 'تست تنظیمات nginx شکست خورد.'
      systemctl reload nginx
    fi
    if [[ -z $PREFIX ]] && have ufw && ufw status 2>/dev/null | grep -q 'Status: active'; then run ufw allow 80/tcp; run ufw allow 443/tcp; fi
  fi
elif [[ $MODE == ip && -z $PREFIX ]] && ! $DRY_RUN && have ufw && ufw status 2>/dev/null | grep -q 'Status: active'; then
  run ufw allow "$PORT/tcp"
fi

# ----------------------------------------------------------------------------- 12. state + helper scripts
if ! $DRY_RUN; then
  write_file "$STATE_FILE" 0644 <<EOF
S_DOMAIN='$DOMAIN'
S_MODE='$MODE'
S_IP='${IP_ADDR:-}'
S_PORT='$PORT'
S_ADMIN='${ADMIN_USER:-}'
S_SRC_KIND='$SRC_KIND'
S_SRC_VALUE='$SRC_VALUE'
S_NO_NGINX='$NO_NGINX'
S_NO_SYSTEMD='$NO_SYSTEMD'
EOF
  chmod +x "$APP_DIR/install.sh" "$APP_DIR"/scripts/update.sh "$APP_DIR"/scripts/backup.sh 2>/dev/null || true
fi

# ----------------------------------------------------------------------------- 13. summary
SIGNUP_NOW=off; [[ $(env_get OPEN_REGISTRATION) =~ ^(1|true)$ ]] && SIGNUP_NOW=on
{
  printf '\n%s========================================================%s\n' "$c_grn" "$c_off"
  printf ' NoSignal is %s.  /  پیام‌رسان آماده است.\n' "$($DRY_RUN && echo 'planned (dry run, nothing changed)' || { $UPGRADE && echo upgraded || echo installed; })"
  printf '%s========================================================%s\n' "$c_grn" "$c_off"
  printf ' Address / آدرس   : %s\n' "$ORIGIN"
  if $SELF_TLS && [[ -z $TLS_CERT && -z $(env_get TLS_CERT_FILE) ]]; then
    printf '\n Trusting the built-in HTTPS certificate (once per device) / اعتماد به گواهی (یک بار برای هر دستگاه):\n'
    printf '   Open %s/ca-help for pictures. Download the CA from %s/ca.crt then:\n' "$ORIGIN" "$ORIGIN"
    printf '   iPhone : open ca.crt in Safari > Allow > Settings > Profile Downloaded > Install; then Settings > General > About > Certificate Trust Settings > enable it.\n'
    printf '   Android: Settings > Security > Encryption & credentials > Install a certificate > CA certificate > pick ca.crt.\n'
    printf '   Desktop: import ca.crt as a trusted root (Windows: certmgr.msc Trusted Root; macOS: Keychain > Always Trust; Linux: update-ca-certificates).\n'
    printf '   آیفون: فایل ca.crt را در Safari باز و نصب کنید، سپس در Settings > General > About > Certificate Trust Settings فعالش کنید. اندروید: تنظیمات > امنیت > نصب گواهی > CA.\n'
  fi
  if $SELF_TLS && (( PORT != 443 )); then
    printf '\n Port %s is used (no root-only port). For https://host without a port: sudo iptables -t nat -A PREROUTING -p tcp --dport 443 -j REDIRECT --to-ports %s\n   (or reinstall with --port 443, which grants the service CAP_NET_BIND_SERVICE).\n' "$PORT" "$PORT"
  fi
  if [[ ${ADMIN_CREATED:-false} == true ]]; then
    printf ' Admin user       : %s\n' "$ADMIN_USER"
    if $ADMIN_PASS_GENERATED; then
      printf ' Admin password   : %s\n' "$ADMIN_PASS"
      printf '                    (shown ONLY now - save it. / فقط همین یک بار نمایش داده می‌شود)\n'
    else printf ' Admin password   : (from your password file)\n'; fi
  fi
  printf ' Open signup      : %s   (change: OPEN_REGISTRATION in %s, then restart)\n' "$SIGNUP_NOW" "$ENV_FILE"
  printf ' Logs             : %s\n' "$($NO_SYSTEMD && echo "$DATA_DIR/server.log" || echo 'journalctl -u tel-messenger -f')"
  printf ' Install log     : %s\n' "$LOG_FILE"
  printf ' Update           : sudo %s/scripts/update.sh%s   (auto-rollback if unhealthy)\n' "$APP_DIR" "${PREFIX:+ --prefix $PREFIX}"
  printf ' Backup           : sudo %s/scripts/backup.sh%s  -> %s\n' "$APP_DIR" "${PREFIX:+ --prefix $PREFIX}" "$BACKUP_DIR"
  [[ -n ${BACKUP_FILE:-} ]] && printf ' Pre-update backup: %s\n' "$BACKUP_FILE"
  printf ' Uninstall        : sudo %s/install.sh --uninstall   (add --purge to delete data)\n' "$APP_DIR"
} >&3
[[ -n ${EARLY:-} ]] && rm -rf "$EARLY"
trap - EXIT
