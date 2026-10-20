<p align="center">
  <img src="assets/brand/nosignal-logo.svg" alt="NoSignal" width="420">
</p>

<p align="center"><b>Self-hosted end-to-end encrypted messenger. Persian-first, with groups, channels and stickers. Runs on your own server, no international internet needed.</b></p>

# NoSignal

A self-hostable, Telegram-style web messenger built for bad networks. One small Node.js server, one SQLite file, a Persian/RTL-first progressive web app. It runs entirely on your own machine with no international internet at runtime: no CDNs, no external fonts, no third-party push or analytics services.

Persian README: [README.fa.md](README.fa.md)

## Features

- **End-to-end encrypted direct chats.** Messages and attachments are encrypted in the browser (P-256 ECDH + HKDF + AES-256-GCM); the server stores only ciphertext. The identity key is backed up automatically, locked with the user's login password (default "Auto" mode, so a new browser just works; the operator could in principle decrypt it, see [SECURITY.md](SECURITY.md)); a "more security" mode keeps the key off the server and uses a recovery key instead.
- **Saved Messages.** Every user has a private chat with themselves, also end-to-end encrypted.
- **Private channels.** One-to-many broadcast channels joined by invite link. Channels are not end-to-end encrypted (the server operator can read posts).
- **Stickers and GIFs.** Per-user sticker packs (including animated TGS) and GIFs.
- **Signup your way.** Invite links by default; optional open signup with just an ID and password (`OPEN_REGISTRATION=1`).
- **Account protection.** Optional TOTP MFA with recovery codes, WebAuthn passkeys, session/device revocation.
- **Weak-network design.** Compressed responses, resumable sync, small payloads, thumbnail placeholders, offline-first local cache, and WebSocket reconnect handling. See [docs/WEAK-NET.md](docs/WEAK-NET.md).
- **Self-host without outside internet.** Everything is bundled; optional built-in HTTPS (`TLS_MODE=auto`) with a local CA for LAN installs.

## Screenshots

_Screenshots will be added here._

## Quick start (server install)

On a fresh Ubuntu 22.04/24.04 or Debian 12 server, as root:

```sh
curl -fsSL https://raw.githubusercontent.com/<owner>/nosignal/main/install.sh \
  | sudo bash -s -- --domain tel.example.com --admin myname
```

No domain, or no internet on the server? Use the fully offline release file: `tar xzf tel-messenger-*-full.tar.gz && cd tel-messenger-*-full && sudo ./install.sh --ip-only --admin myname`. Details: [docs/INSTALL.md](docs/INSTALL.md).

## Quick start (development)

Requirements: Node.js 24, ffmpeg and ffprobe on `PATH`.

```sh
npm ci
cp .env.example .env     # set SESSION_SECRET, TRUSTED_ORIGINS, DATA_DIR
npm run build
npm run migrate
npm run user:add -- admin "Admin" --admin   # first account, created via the CLI
npm run start
```

Open the address in `TRUSTED_ORIGINS`. For production (systemd, nginx, backups, TLS) read [DEPLOYMENT.md](DEPLOYMENT.md). A non-technical Persian install guide is in [INSTALL-FA.md](INSTALL-FA.md).

## Documentation

- [DEPLOYMENT.md](DEPLOYMENT.md) - install, upgrade, backup, reverse proxy
- [SECURITY.md](SECURITY.md) - threat model, E2EE boundary, reporting vulnerabilities
- [docs/](docs/) - saved messages, channels, groups, attachments, database, weak-network notes
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

## Tests

```sh
npm test
npm run test:security
```

## License

MIT, see [LICENSE](LICENSE). Bundled fonts and dependencies keep their own licences, listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

> **No password recovery.** There is deliberately no "forgot password" flow and no admin reset tool: nobody, including the server operator, can get into an account without its password. Users are warned at signup.
