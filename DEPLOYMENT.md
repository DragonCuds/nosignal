# Self-hosted deployment

NoSignal is portable: application state, the SQLite database, and uploads all live under `DATA_DIR`. PostgreSQL is not required. The default server binds to `127.0.0.1`; put it behind HTTPS when exposing it beyond the host.

## Install

Install Node.js 24 and ffmpeg/ffprobe. Create an unprivileged account and private data directory:

```sh
sudo useradd --system --home /var/lib/tel-messenger --shell /usr/sbin/nologin tel-messenger
sudo install -d -o tel-messenger -g tel-messenger -m 0700 /var/lib/tel-messenger
sudo install -o root -g tel-messenger -m 0640 .env.example /etc/tel-messenger.env
npm ci
npm run build
```

Edit `/etc/tel-messenger.env`, set `DATA_DIR=/var/lib/tel-messenger`, and generate `SESSION_SECRET` with `openssl rand -base64 48`. Never commit or print the resulting file. Initialize or upgrade the database with the same service environment:

```sh
sudo systemd-run --wait --pipe --collect \
  --property=User=tel-messenger \
  --property=WorkingDirectory=/srv/tel-messenger \
  --property=EnvironmentFile=/etc/tel-messenger.env \
  --setenv=NODE_ENV=production /usr/bin/npm run migrate
```

The included `deploy/tel-messenger.service.in` is the systemd template. Its service user needs write access only to `DATA_DIR`; application code can remain read-only. After installing the unit:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now tel-messenger
curl --fail http://127.0.0.1:3050/api/health
```

## First account and signup policy

There is no default account. Create the first account (the administrator) on the server with the CLI, from the application directory with the same environment as the service:

```sh
npm run user:add -- admin "Admin" --admin
```

It prompts for a password (use a long one). Without `--admin` the same command creates a normal user. After that, the admin can create invite links from Settings.

`OPEN_REGISTRATION` (in `.env`, default off) controls public signup. Off: accounts are created only by the CLI or by invite links. `1`/`true`: anyone can register at `/api/register` with an ID (3-32 chars of `a-z 0-9 _`) and a password of at least 8 characters; registration is rate-limited per IP and new users are never admins. Invites keep working in both modes. Set `TRUSTED_ORIGINS` (for example `https://tel.example.com`) and `WEBAUTHN_RP_ID` (`tel.example.com`) to your real domain before exposing the service.

## Telegram sticker import (optional)

Users can paste a `t.me/addstickers/NAME` link in the sticker picker to copy a Telegram sticker pack into their own library. It uses a bot owned by the operator and is completely off until you set a token (the UI then says the operator has not configured the Telegram bot).

1. Create a bot with @BotFather (`/newbot`) and copy its token.
2. Put `TELEGRAM_BOT_TOKEN=<token>` in the server env file and restart the service.
3. The server must reach `api.telegram.org`. Where Telegram is blocked, set `TELEGRAM_API_BASE` to a mirror/reverse proxy, or (Node 24) set `NODE_USE_ENV_PROXY=1` and `HTTPS_PROXY=http://host:port` in the same file.

The token never leaves the server (it is not sent to clients, logged, or included in errors) and users never talk to the bot. Limits: 120 stickers per pack, 512 KB per file, 5 imports per user per hour, 60 s per import; static `.webp`, animated `.tgs` and video `.webm` stickers are stored as-is under the usual sticker rules. Re-importing a pack adds only missing stickers. Sticker artwork belongs to its creators; the feature is meant for personal use, and Telegram's terms apply.

If the server cannot reach Telegram, run the standalone bot in `tools/telegram-sticker-zip-bot/` on any machine that can (see its README): users send it a pack link and upload the ZIP it returns through "Add pack" in the sticker picker. Both ways can be used side by side; the bot is never installed on the server.

## Moving an existing PostgreSQL installation

Stop writers, restore a `pg_dump` into a throw-away PostgreSQL database, then run the converter against that copy. Never point migration testing at the live database.

```sh
DATABASE_URL='postgresql://.../tel_messenger_move_test' \
  node scripts/pg-to-sqlite.mjs --dry-run
DATABASE_URL='postgresql://.../tel_messenger_move_test' \
  node scripts/pg-to-sqlite.mjs --output /var/lib/tel-messenger/tel.db --include-sessions
```

Confirm every printed source/SQLite count matches before starting the service. Keep the PostgreSQL dump until login, messaging, media retrieval, and a backup restore have been verified.

## Backup and restore

SQLite WAL mode is enabled. For the simplest consistent backup, briefly stop the service and archive the complete data directory:

```sh
sudo systemctl stop tel-messenger
sudo tar -C /var/lib -czf tel-messenger-$(date -u +%Y%m%dT%H%M%SZ).tar.gz tel-messenger
sudo systemctl start tel-messenger
```

Restrict archives to mode `0600`, keep an encrypted off-host copy, and periodically restore one into a separate directory and run the test suite. Restoring is the reverse: stop the service, replace `DATA_DIR` from a verified archive with the correct ownership, run `npm run migrate`, and restart.

## Behind your own nginx

If nginx already terminates HTTPS, proxy HTTP to `127.0.0.1:3050`. Preserve `Host` and forwarding headers, use WebSocket upgrade headers for `/ws`, allow the configured upload size, and keep read timeouts above the 25-second heartbeat. Test nginx configuration before reloading it. TLS certificates, DNS, and firewall policy are operator-managed; they are not required for a local-only installation.

For releases, stop or drain the service, make a backup, run `npm ci`, `npm run build`, and `npm run migrate`, then restart and verify health. Rotating `SESSION_SECRET` logs out every existing session.
