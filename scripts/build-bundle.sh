#!/usr/bin/env bash
# Builds ONE self-contained release file.
#   scripts/build-bundle.sh [--light] [output-dir]
# default (full):  nosignal-<ver>-linux-x64-full.tar.gz  = app + production node_modules (prebuilt native modules)
#                  + pinned Node.js 24 binary + static ffmpeg/ffprobe + installer. Installs on a server with ZERO internet.
# --light:         nosignal-<ver>-linux-<arch>-light.tar.gz = same without Node/ffmpeg (server needs them installed).
# Each file gets a .sha256 next to it and a SHA256SUMS inside.
# Run on linux-x64 with internet (or with the downloads cached in $VENDOR_DIR).
# Env: VENDOR_DIR (cache for downloaded tarballs, default <repo>/dist-bundle/vendor)
set -euo pipefail
LIGHT=false; [ "${1:-}" = --light ] && { LIGHT=true; shift; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(realpath -m "${1:-$SRC/dist-bundle}")"
VENDOR="$(realpath -m "${VENDOR_DIR:-$SRC/dist-bundle/vendor}")"
[ "$(uname -s)" = Linux ] || { echo "Build on Linux (native modules are platform specific)." >&2; exit 1; }
ARCH="$(uname -m)"; VER="$(node -p "require('$SRC/package.json').version")"
if $LIGHT; then FILE="nosignal-$VER-linux-$ARCH-light.tar.gz"; else
  [ "$ARCH" = x86_64 ] || { echo "Full bundle is built for linux-x64 only (pinned binaries)." >&2; exit 1; }
  FILE="nosignal-$VER-linux-x64-full.tar.gz"; fi
NAME="${FILE%.tar.gz}"
NODE_VERSION=24.22.0
NODE_SHA256=cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008
NODE_TAR="node-v$NODE_VERSION-linux-x64.tar.xz"
# LGPL build (no --enable-gpl / --enable-nonfree), immutable dated release tag (not the rolling "latest")
FF_TAR="ffmpeg-n8.1.3-18-g46d899d7a0-linux64-lgpl-8.1.tar.xz"
FF_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-20-13-08/$FF_TAR"
FF_SHA256=6369d7e2e647d3b467ba01b5779f211fb45acf5895a15514e0426f959d3563b4
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT; mkdir -p "$OUT" "$VENDOR"
fetch() { # fetch file url sha256
  [ -f "$VENDOR/$1" ] || curl -fL --retry 3 -o "$VENDOR/$1" "$2"
  echo "$3  $VENDOR/$1" | sha256sum -c - >/dev/null || { echo "SHA256 mismatch for $1 (expected $3)" >&2; exit 1; }
}
echo "== 1/5 copy sources"
mkdir "$W/src"
( cd "$SRC" && tar --exclude=./node_modules --exclude='*/node_modules' --exclude=./data --exclude=./data-test --exclude=./shots \
    --exclude=./.git --exclude=./.env --exclude=./.agents --exclude=./tasks --exclude=./tests --exclude=./dist-bundle \
    --exclude='./apps/*/dist' --exclude='./packages/*/dist' -cf - . ) | tar -xf - -C "$W/src" || [ $? -le 1 ]
cd "$W/src"
echo "== 2/5 build"
npm ci --no-audit --no-fund
for w in packages/media-contract packages/stickers apps/server apps/web; do npm run build --workspace="$w"; done
echo "== 3/5 production node_modules + assemble"
rm -rf node_modules apps/*/node_modules packages/*/node_modules
npm ci --omit=dev --no-audit --no-fund
B="$W/$NAME"; mkdir "$B"
cp -a package.json package-lock.json node_modules deploy docs assets "$B/"
for f in LICENSE README.md README.fa.md INSTALL-FA.md DEPLOYMENT.md SECURITY.md THIRD-PARTY-NOTICES.md .env.example install.sh; do [ -e "$f" ] && cp "$f" "$B/"; done
mkdir "$B/scripts"; cp scripts/update.sh scripts/backup.sh scripts/renew-local-cert.mjs scripts/regenerate-ca.mjs "$B/scripts/"
for d in apps/server apps/web packages/media-contract packages/stickers; do
  mkdir -p "$B/$d"; cp "$d/package.json" "$B/$d/"
  [ -d "$d/node_modules" ] && cp -a "$d/node_modules" "$B/$d/"
  [ -d "$d/dist" ] && cp -a "$d/dist" "$B/$d/"
done
cp -a apps/server/migrations "$B/apps/server/"
rm -f "$B/deploy/FULL-BUNDLE-NOTICES.md"
if ! $LIGHT; then
  echo "== 4/5 Node.js $NODE_VERSION + ffmpeg (pinned, checksummed)"
  fetch "$NODE_TAR" "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TAR" "$NODE_SHA256"
  fetch "$FF_TAR" "$FF_URL" "$FF_SHA256"
  mkdir -p "$B/node/bin" "$B/bin" "$B/LICENSES" "$W/n" "$W/f"
  tar -xJf "$VENDOR/$NODE_TAR" -C "$W/n" --strip-components=1
  cp "$W/n/bin/node" "$B/node/bin/node"; cp "$W/n/LICENSE" "$B/LICENSES/node-LICENSE"
  tar -xJf "$VENDOR/$FF_TAR" -C "$W/f" --strip-components=1
  cp "$W/f/bin/ffmpeg" "$W/f/bin/ffprobe" "$B/bin/"; cp "$W/f/LICENSE.txt" "$B/LICENSES/ffmpeg-LICENSE.txt"
  cat "$SRC/deploy/FULL-BUNDLE-NOTICES.md" >> "$B/THIRD-PARTY-NOTICES.md"
  printf 'node %s %s\nffmpeg %s %s\n' "$NODE_VERSION" "$NODE_SHA256" "$FF_URL" "$FF_SHA256" > "$B/LICENSES/SOURCES.txt"
  NODEBIN="$B/node/bin/node"
else NODEBIN=node; fi
chmod +x "$B/install.sh" "$B/scripts/"*.sh
echo "linux-$ARCH" > "$B/.release-bundle"; echo "$VER" > "$B/VERSION"
echo "== self-check (native modules load with the bundled node)"
( cd "$B/apps/server" && "$NODEBIN" --input-type=module -e "import 'better-sqlite3';import 'argon2';import 'fastify';import 'ws';console.log('self-check ok, node', process.version)" )
$LIGHT || {
  FFBC="$("$B/bin/ffmpeg" -hide_banner -buildconf 2>&1)"
  if echo "$FFBC" | grep -qE -- '--enable-(gpl|nonfree)'; then echo "ffmpeg build is GPL/nonfree: refusing to ship it" >&2; exit 1; fi
  ENC="$("$B/bin/ffmpeg" -hide_banner -encoders 2>/dev/null)"
  for e in libopenh264 libwebp; do echo "$ENC" | grep -q " $e " || { echo "bundled ffmpeg lacks encoder $e" >&2; exit 1; }; done
  echo "ffmpeg is LGPL (no gpl/nonfree) and has libopenh264 + libwebp"; }
( cd "$B" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS )
echo "== 5/5 tarball"
tar -C "$W" -czf "$OUT/$FILE" "$NAME"
( cd "$OUT" && sha256sum "$FILE" | tee "$FILE.sha256" )
du -h "$OUT/$FILE"
