#!/usr/bin/env bash
# Builds ONE tarball that installs and runs with no internet (linux-x64).
# Run on a machine WITH internet:  scripts/build-bundle.sh [output-dir]
# Env: NODE_TARBALL=path to node-v24*-linux-x64.tar.xz (default: copy local node if linux-x64)
#      FFMPEG_DIR=dir holding static ffmpeg+ffprobe (default: download static build; SKIP_FFMPEG=1 to omit)
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(realpath -m "${1:-$SRC/dist-bundle}")"
[ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ] || { echo "Build on linux-x64 (native parts are built for this platform)." >&2; exit 1; }
VER="$(node -p "require('$SRC/package.json').version")"
NAME="nosignal-$VER-linux-x64"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
B="$W/$NAME"; mkdir -p "$B/app" "$B/bin" "$B/node" "$OUT"

echo "== 1/6 copy sources + build"
mkdir -p "$W/src-tmp"
( cd "$SRC" && tar --exclude=./node_modules --exclude='*/node_modules' --exclude=./data --exclude=./.git --exclude=./dist-bundle \
    --exclude='./apps/*/dist' --exclude='./packages/*/dist' --exclude=./tests --exclude=./tasks \
    --exclude=./apps/web/screenshots -cf - . ) | tar -xf - -C "$W/src-tmp"
cd "$W/src-tmp"
npm ci --no-audit --no-fund
# packages first: server/web import their built output (plain `npm run build` goes alphabetically and fails on a clean tree)
for w in packages/media-contract packages/stickers apps/server apps/web; do npm run build --workspace="$w"; done
echo "== 2/6 production node_modules (native parts prebuilt)"
rm -rf node_modules
npm ci --omit=dev --no-audit --no-fund
cp -a node_modules package.json package-lock.json "$B/app/"
for d in apps/server apps/web packages/media-contract packages/stickers; do
  mkdir -p "$B/app/$d"; cp package.json "$B/app/package.json"
  cp "$d/package.json" "$B/app/$d/"
  [ -d "$d/node_modules" ] && cp -a "$d/node_modules" "$B/app/$d/"  # npm nests some deps per workspace (e.g. fastify)
  [ -d "$d/dist" ] && cp -a "$d/dist" "$B/app/$d/" || true
done
cp -a apps/server/migrations "$B/app/apps/server/"
echo "== 3/6 node runtime"
if [ -n "${NODE_TARBALL:-}" ]; then tar -xJf "$NODE_TARBALL" -C "$B/node" --strip-components=1 --wildcards '*/bin/node'
else cp "$(command -v node)" "$B/node/node"; mkdir -p "$B/node/bin"; mv "$B/node/node" "$B/node/bin/node"; fi
"$B/node/bin/node" -v | grep -q '^v24\.' || { echo "Node runtime is not v24" >&2; exit 1; }
echo "== 4/6 ffmpeg"
if [ -n "${FFMPEG_DIR:-}" ]; then cp "$FFMPEG_DIR/ffmpeg" "$FFMPEG_DIR/ffprobe" "$B/bin/"
elif [ "${SKIP_FFMPEG:-0}" != 1 ]; then
  # LGPL build only (same pin as scripts/build-bundle.sh)
  curl -fsSL https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-20-13-08/ffmpeg-n8.1.3-18-g46d899d7a0-linux64-lgpl-8.1.tar.xz -o "$W/ff.txz"
  echo "6369d7e2e647d3b467ba01b5779f211fb45acf5895a15514e0426f959d3563b4  $W/ff.txz" | sha256sum -c - >/dev/null
  mkdir "$W/ff"; tar -xJf "$W/ff.txz" -C "$W/ff" --strip-components=1; cp "$W/ff/ffmpeg" "$W/ff/ffprobe" "$B/bin/"
fi
echo "== 5/6 installer + docs"
cp "$SRC/.env.example" "$B/.env.example"
cp "$SRC/INSTALL-FA.md" "$B/"
cp -a "$SRC/deploy" "$B/deploy"
cp "$SRC/scripts/bundle/install.sh" "$B/install.sh"; cp "$SRC/scripts/bundle/tel-user-add" "$B/tel-user-add"; chmod +x "$B/install.sh" "$B/tel-user-add"
echo "$VER" > "$B/VERSION"
echo "== self-check (bundled node loads native parts)"
( cd "$B/app/apps/server" && "$B/node/bin/node" --input-type=module -e "import 'better-sqlite3';import 'argon2';import 'fastify';import 'ws';console.log('native + server deps ok')" )
echo "== 6/6 tarball"
tar -C "$W" -cJf "$OUT/$NAME.tar.xz" "$NAME"
( cd "$OUT" && sha256sum "$NAME.tar.xz" | tee "$NAME.tar.xz.sha256" )
du -h "$OUT/$NAME.tar.xz"
