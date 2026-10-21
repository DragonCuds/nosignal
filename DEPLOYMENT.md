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

Edit `/etc/tel-messenger.env`, set `DATA_DIR=/var/lib/tel-messenger`, generate `SESSION_SECRET` with `openssl rand -base64 48`, and generate a separate 32-byte `CHANNEL_KEYRING` entry with `openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'`. Set `CHANNEL_ACTIVE_KEY_ID` to that entry's ID. Never commit or print the resulting file. Initialize or upgrade the database with the same service environment:

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

## Channel wrapping keys and rotation

Channel keys are server-held, so keep `CHANNEL_KEYRING` backed up with the database. Its format is `id:base64url-key,id2:base64url-key`, with each key exactly 32 random bytes. `CHANNEL_ACTIVE_KEY_ID` selects the key for new channels. Do not reuse `SESSION_SECRET` as a channel key. A database backup without the matching channel keyring cannot recover channel keys.

For the first upgrade from a release without `CHANNEL_KEYRING`, **keep the original `SESSION_SECRET`**. Stop the service, back up and restore-test the database and environment file in an isolated directory, add a new channel keyring entry, then run `npm run migrate` with the original secret. This rewraps old rows under the new key and verifies every row; it can be rerun after interruption. The installer creates a separate key if the env file has none. Check `SELECT key_id, count(*) FROM channels GROUP BY key_id` and read an old channel before rotating `SESSION_SECRET`.

To rotate channel keys, add a new `id:key` entry, set `CHANNEL_ACTIVE_KEY_ID` to the new ID, stop writers, back up and restore-test the database and environment file, then run `npm run migrate`. All rows are rewrapped to the active ID. Verify old and new channel reads and the key ID counts before removing the old entry. Keep old keys through the retention period of any database backup that needs them. If a migration fails, keep both keys and rerun it after resolving the error; restore the paired database and env backup for rollback. Code from before this migration cannot read rewrapped rows, so rollback must restore the pre-upgrade database too. Rotating `SESSION_SECRET` separately logs out existing sessions; after the initial channel migration it does not change channel wrapping.

## Behind your own nginx

If nginx already terminates HTTPS, proxy HTTP to `127.0.0.1:3050`. Preserve `Host` and forwarding headers, use WebSocket upgrade headers for `/ws`, allow the configured upload size, and keep read timeouts above the 25-second heartbeat. Test nginx configuration before reloading it. TLS certificates, DNS, and firewall policy are operator-managed; they are not required for a local-only installation.

## Local CA (`TLS_MODE=auto`)

Use a publicly trusted certificate for a public DNS name. Auto mode creates a private CA for LAN use. Installing `/ca.crt` gives that CA trust on a client device; obtain its SHA-256 fingerprint with `openssl x509 -in "$DATA_DIR/tls/ca.crt" -noout -fingerprint -sha256`, check it through a separate trusted channel, and limit trust to the app where the client supports it. A CA name constraint is defense in depth, and client trust-anchor handling varies. Never describe the CA as universally restricted to this server.

Fresh CAs constrain configured DNS hosts exactly (including an exclusion for subdomains) and IP addresses individually. For an IP-only configuration, X.509/OpenSSL cannot encode an empty DNS permitted set, so a random host under the reserved `.invalid` TLD is permitted. Other DNS names are rejected by OpenSSL path validation. Keep the CA signing key offline to limit the impact of a service-account compromise:

1. After initial issuance, stop the service and move `DATA_DIR/tls/ca.key` to protected offline storage outside `DATA_DIR`, readable only by the operator. Keep an encrypted backup. Start the service; a fresh server certificate works without the CA key.
2. Before the server certificate enters its 30-day renewal window, stop the service. Temporarily restore `ca.key` to `DATA_DIR/tls/` with mode `0600`, then run `node scripts/renew-local-cert.mjs --data-dir "$DATA_DIR" --hosts "$TLS_HOSTS"`. Move the CA key back offline before starting the service. The script only renews the leaf under the existing CA. Test a restore and set a calendar reminder; unattended renewal is unavailable while the key is offline.
3. If the CA expires or configured hosts change beyond its constraints, plan client trust migration. `scripts/regenerate-ca.mjs --yes` explicitly replaces the CA and keeps the previous files in a protected backup. Distribute and verify the new CA, remove the old CA from every device, and retire its key after migration. Startup and routine renewal will never silently replace a CA.

Existing CAs keep their original constraints until explicitly replaced. Check the current CA and supported client validators before migration. Do not install a new root in the host's main trust store merely for testing.

The WebSocket server allows up to 6 connections per session, 12 per user, 32 per IP, and 512 overall. Authentication has a 5-second deadline and at most 8 pending upgrades per IP (64 overall). A connection is closed if its outgoing queue exceeds 1 MiB. When nginx runs on the same host, overwrite `X-Real-IP` with `$remote_addr` as the bundled installer does; do not forward a client-supplied value. These limits apply to each server process.

Invite links contain bearer tokens in `/join/<token>`, `/c/<token>`, `/api/invites/<token>` and `/api/channels/join/<token>`. Do not log `$request`, `$request_uri`, `$args` or `$http_referer` in a reverse proxy or tracing system. Log `$uri` after replacing the token segment with `[redacted]`; the bundled installer generates this access-log policy and disables Nginx error logs that can include raw URLs. Apply an equivalent policy to an existing or external proxy before accepting invite traffic. Restrict access to historical logs that may already contain live tokens.

For releases, stop or drain the service, make a backup, run `npm ci`, `npm run build`, and `npm run migrate`, then restart and verify health. Rotating `SESSION_SECRET` logs out every existing session.
