#!/usr/bin/env bash
# Upgrade NoSignal in place: back up the database, fetch + build the new code in a side folder,
# swap, migrate, restart, wait for /api/health. If the new version is not healthy the previous code
# AND the database backup are restored automatically.
# Usage: sudo scripts/update.sh [--ref TAG] [--source TARBALL] [--prefix DIR] [--dry-run]
# راهنما: همین دستور را بزنید؛ اگر نسخه‌ی جدید سالم بالا نیاید، خودکار به نسخه‌ی قبل برمی‌گردد.
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
installer="$here/../install.sh"
[[ -f $installer ]] || { echo 'install.sh not found next to scripts/' >&2; exit 1; }
exec bash "$installer" --update --yes "$@"
