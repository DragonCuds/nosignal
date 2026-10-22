# Installing NoSignal on a server

Supported: Ubuntu 22.04 / 24.04, Debian 12 (x86_64; arm64 for the online flow), run as root with systemd.
Persian guide: [INSTALL-FA.md](../INSTALL-FA.md).

> Naming: the product is called NoSignal, but internal names keep the `tel-messenger` prefix (npm packages `@tel-messenger/*`, the `tel-messenger` systemd service and user, `/opt/tel-messenger`, `/etc/tel-messenger.env`, release file names). They are not renamed so existing installs keep working.

There are two ways. Both use the same `install.sh` and both are safe to re-run (re-running upgrades in place).

## A. Fully offline release file (no internet on the server)

Download `nosignal-<version>-linux-x64-full.tar.gz` (and its `.sha256`) once, copy it to the server, then:

```sh
sha256sum -c nosignal-*-full.tar.gz.sha256      # optional
tar xzf nosignal-*-full.tar.gz && cd nosignal-*-full
sudo ./install.sh --ip-only --admin myname            # or: --domain tel.example.com
```

The file contains the built app, production `node_modules` with prebuilt native modules, Node.js 24, static `ffmpeg`/`ffprobe` and the installer.
The installer touches **no system package** and calls no network: no apt, npm, git, curl, nginx or certbot. It needs only root, systemd and `openssl` (present on standard Ubuntu/Debian).
The app serves HTTPS itself (`TLS_MODE=auto`: a private CA and server certificate created under the data folder). Each phone/PC must trust that CA once: open `https://<server>:3050/ca-help`.

New CAs are name-constrained: they are only valid for the names and IPs in `TLS_HOSTS`, so a leaked `tls/ca.key` cannot be used to impersonate other websites. If you add a new host/IP to `TLS_HOSTS` later, a new CA is created and phones must install `/ca.crt` again. CAs created by older versions have no such limit and keep working; to upgrade one (opt-in, phones must re-install `/ca.crt`):

```
node scripts/regenerate-ca.mjs --yes --data-dir "$DATA_DIR" --hosts "$TLS_HOSTS"   # then restart the service
```

The old files are kept in `tls/backup-<time>/`; delete that folder once every device has the new CA.
To use a certificate you already own: `--cert fullchain.pem --key privkey.pem` (with `--domain`).
Default port is 3050 (no root-only port). For 443 either install with `--port 443` (the unit gets `CAP_NET_BIND_SERVICE`) or redirect: `iptables -t nat -A PREROUTING -p tcp --dport 443 -j REDIRECT --to-ports 3050`.
`/usr/bin/ffmpeg` and `/usr/bin/ffprobe` are linked to the bundled ones only if the system has none (the app calls those paths).
The bundled ffmpeg is an LGPL build (no GPL or non-free components, H.264 via OpenH264): see `THIRD-PARTY-NOTICES.md` for the licence and where to get its source.

Update: copy the new release file and run `sudo /opt/tel-messenger/scripts/update.sh --source nosignal-NEW-full.tar.gz`.

On an installed copy the scripts run with the bundled Node, as the service user and with the service's environment, for example (service stopped, `ca.key` in place; see DEPLOYMENT.md):

```sh
sudo systemctl stop tel-messenger
sudo -u tel-messenger bash -c 'set -a; . /etc/tel-messenger.env; set +a; cd /opt/tel-messenger && ./node/bin/node scripts/renew-local-cert.mjs'
sudo systemctl start tel-messenger
```

## B. Online install (git/npm/apt, nginx + Let's Encrypt)

```sh
curl -fsSL https://raw.githubusercontent.com/<owner>/nosignal/main/install.sh \
  | sudo bash -s -- --domain tel.example.com --admin myname
```

or from a clone: `sudo ./install.sh --domain tel.example.com --admin myname`. It installs Node 24 (NodeSource, falling back to the nodejs.org tarball; `--node-tarball PATH|URL` for a mirror), ffmpeg, nginx, certbot, builds the app, writes the nginx site (WebSocket, upload size, gzip off) and gets a certificate. The domain's A record must already point to the server (checked first; `--skip-dns-check` to override). Without a domain use `--ip-only`.

## What the installer does
Checks OS/arch/RAM/disk; creates user `tel-messenger`; installs the app in `/opt/tel-messenger`, data in `/var/lib/tel-messenger` (mode 0700); writes `/etc/tel-messenger.env` (random `SESSION_SECRET`, `TRUSTED_ORIGINS`, `WEBAUTHN_RP_ID`, `OPEN_REGISTRATION`); installs the hardened systemd unit; runs migrations; creates the first admin (password printed once, or `--admin-password-file`); waits for `/api/health`; prints the URL and next steps. Log: `/var/log/tel-messenger-install.log`.

Flags: `--open-signup` (anyone may register; default off), `--port`, `--email`, `--repo/--ref`, `--source`, `--node-tarball`, `--cert/--key`, `--no-nginx`, `--dry-run` (print the plan), `--uninstall [--purge]`, `--prefix DIR` (test install under DIR, run as the current user), `-h`.

## Safety
- The env file and data are never overwritten on re-run; `--open-signup` / `--no-open-signup` change only that one key.
- Before an upgrade `tel.db` is copied (SQLite online backup) to `/var/backups/tel-messenger/`. The new version is prepared beside the old one; if `/api/health` does not come up, the old code and the database copy are restored automatically.
- Backup any time: `sudo /opt/tel-messenger/scripts/backup.sh` (database + uploads, keeps the last 14).
- Uninstall: `sudo /opt/tel-messenger/install.sh --uninstall` keeps data; add `--purge` to delete data and settings.

## Building the release file (maintainers)
`scripts/build-bundle.sh [outdir]` builds the full file (pinned Node and ffmpeg, SHA256-verified); `scripts/build-bundle.sh --light` builds one without them.
