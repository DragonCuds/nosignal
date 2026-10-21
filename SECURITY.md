# NoSignal security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through **GitHub private security advisories**: open the repository's "Security" tab and choose "Report a vulnerability". Do not open a public issue containing exploit details, credentials, private messages, database contents, uploaded media, cookies, or logs with personal data. Include the affected revision, impact, reproduction steps, and any suggested mitigation. The maintainers will acknowledge, triage, fix, and coordinate disclosure before details become public.

## What is and is not end-to-end encrypted

- Direct chats and Saved Messages are end-to-end encrypted (details below).
- **Channels are not end-to-end encrypted: the server operator can read channel posts.** Treat channel content as visible to whoever runs the server.

## Supported deployment

Security fixes target the current main-branch revision on Node.js 24 with supported nginx (or the built-in TLS mode) and ffmpeg packages. Data is stored in SQLite under `DATA_DIR`. Older revisions and modified public-network listeners are not supported. Follow [DEPLOYMENT.md](DEPLOYMENT.md) for the expected trust boundaries.

## Operator baseline

- Terminate TLS at nginx (or use `TLS_MODE`) and keep Node bound to loopback unless clients connect directly.
- For public DNS names, use a publicly trusted certificate. In `TLS_MODE=auto`, treat `ca.key` as a signing authority: store it offline after initial issuance and restore it only during planned leaf renewal. See [DEPLOYMENT.md](DEPLOYMENT.md#local-ca-tls_modeauto). X.509 name constraints do not guarantee that every client limits a manually trusted root identically.
- Run the service as an unprivileged account with a read-only application tree and a single writable `DATA_DIR`.
- Keep `.env` outside the repository where possible, mode `0640` or stricter, and readable only by root and the service group. Never commit secrets.
- Use a unique random session secret. Rotate any value that may have been disclosed. Changing `SESSION_SECRET` invalidates all sessions.
- Treat the database and uploaded media as sensitive personal data. Encrypt off-host backups and regularly test restoration.
- Retain minimal logs and never record passwords, session cookies, authorization headers, message bodies, or uploaded content.
- Keep dependencies and the host patched. Review `npm audit` results in context and test upgrades before production rollout.
- Require the Security CI workflow on the default branch. It builds from the lockfile, runs security regression tests, audits production dependencies, reviews dependency changes, and performs CodeQL analysis.

## Application notes

Authentication cookies are `Secure`, `HttpOnly`, and `SameSite=Strict`, so production requires HTTPS. Login has an application-level rate limit; the reverse proxy should add per-address limits as defense in depth. Uploaded content is processed by ffmpeg and must remain size-limited. Only authenticated operators should receive user creation or sticker-pack import access.

The health endpoint is intentionally unauthenticated and returns only service status. Monitor it through loopback or a restricted monitoring path; it does not prove database health.

Presence events (online and last seen) are sent only to current members of a two-person direct chat whom that user has messaged. Creating a chat or adding someone to a group does not grant presence access. Deleting the user's last active message to a recipient or removing that recipient from the chat ends access on the next presence event. Presence is not shown to group or channel members through membership alone.

## End-to-end encryption and its boundary

New direct-chat and Saved Messages content is encrypted in the browser before upload. The client keeps the
P-256 identity private key in IndexedDB, derives an envelope key with ECDH +
HKDF-SHA-256, and encrypts message content and chat keys with AES-256-GCM. The server stores only
ciphertext, nonces, public identities, and recipient envelopes. A locally pinned identity
fingerprint prevents a silently changed contact key on that browser profile.

**Key storage.** The identity private key is stored in IndexedDB as an *extractable* WebCrypto key, both
when it is first created and when it is restored from a backup. This is deliberate: key backup (the
automatic password-wrapped copy, the recovery key and the `.telkey` file) needs to export it. The
consequence is that the key can be read by JavaScript running in the application's origin and by anyone
with access to the browser profile. If either is compromised, the identity key and the messages
encrypted for it are exposed. Using a non-extractable key would not fully prevent this either, because
such code could still use the key to decrypt. Only keys created by much older versions may be stored
non-extractable, and those cannot be backed up. Protect the origin (no third-party scripts, strict CSP)
and the device. A design with a non-extractable working key and an encrypted-only recoverable copy is
possible future work.

All new message writes use the version-2 envelope. Its authenticated data binds the ciphertext to
the chat, sender, client-generated cipher ID, and visible message kind. Nonces are exactly 96 bits,
and the database permanently records used cipher IDs so a captured ciphertext cannot be submitted
again through the application. The database's unvalidated write-policy constraint preserves access
to version-1/legacy rows while rejecting any new active row that is not a version-2 ciphertext.
Legacy plaintext already present before migration 004 is not retroactively protected; operators
must disclose or deliberately remove that history according to their retention requirements.

This is deliberately **not** described as Signal- or MLS-grade encryption. It has no ratchet or
forward secrecy, no device-to-device key transfer (a new browser gets the key back through the key backup below), and the first contact is trust-on-first-use; compare
identity fingerprints through a separate channel before relying on protection from a malicious
server. The server can still see account identities, direct-chat membership, message timing, message
type, reply relationships, and encrypted attachment sizes. Media sent in a chat is copied into a
fresh AES-256-GCM encrypted blob in the browser; the server stores and serves only that ciphertext.
The sticker/GIF catalogue itself is visible to the server, but the encrypted message and randomized
chat blob do not disclose which catalogue item was sent. Without a key backup, losing browser storage loses the corresponding private key and access
to ciphertext encrypted for that identity (see "Key backup" next). These limitations are material and must remain visible in
any public security claim.

## Key backup: Auto mode (default) and Power mode

The identity private key never reaches the server in the clear, but what protects it depends on the mode the user is in.

- **Auto mode (default).** The browser wraps the identity key (AES-256-GCM) with a key derived from the **login password** (PBKDF2-SHA256, 600,000 iterations, random salt, version field; all client-side) and uploads only that wrapped blob (`PUT /api/crypto/backup`, one row per user, size and rate limited). After any password login on a new browser or after browser data was cleared, the client downloads the blob, opens it with the password just typed, and the old messages are readable with no extra step. Existing users with a local key and no server copy get the upload at their next password login. Changing the account password in Settings rewraps the same identity with the new password; the server updates the password hash, backup, and sessions in one transaction. A backup that cannot be opened with the current password requires explicit recovery before changing the password. Backup writes require the current password and an expected revision. Replacing an existing copy also requires a five-minute, one-use authorization bound to the account, session, operation, and backup revision. Enabled TOTP or a recovery code is required to obtain that authorization.
- **What Auto mode costs.** The server receives the password at login (it must, to verify it), so **an operator who modifies the server code or captures a login could decrypt the stored blob and therefore read direct chats.** What remains protected: someone who only obtains the database (a leaked backup or disk) must break PBKDF2 at 600k iterations against the user's password; a strong, unique password makes that impractical, a weak one does not. This is a deliberate usability trade-off chosen by the project owner; the server operator is no longer fully excluded in this mode.
- **Power mode (opt-out, Settings → "more security mode").** The server copy is deleted (`DELETE /api/crypto/backup`) and the account is marked `manual`, so clients never upload again. Deletion and switching back to Auto require the same short-lived authorization. The user keeps a recovery key (text) and/or a passphrase-protected `.telkey` file. On a new device the app shows a friendly screen: enter the recovery key/file, or "start fresh". The operator cannot decrypt anything in this mode; losing the recovery key means the old messages are gone for good.
- **Start fresh.** `POST /api/crypto/identity/reset` requires a short-lived, one-use authorization issued after password verification and, if enabled, TOTP or recovery-code verification. It deletes the account's old identity, the chat key envelopes of every chat the user is in (both sides, so old messages in those chats become unreadable for everyone), and any stored blob; the chosen mode is kept. The confirmation screen warns about the effect on contacts. Contacts' browsers that pinned the old fingerprint will report an identity change for that person. These actions appear in the account's backup security activity.
- Account deletion removes the stored blob (`ON DELETE CASCADE`). Backups of the database contain the wrapped blobs.

## Account protection

Optional TOTP MFA (with single-use recovery codes), WebAuthn passkeys with user verification, and
session/device revocation are available from Settings. MFA secrets are encrypted at rest under a key
derived from `SESSION_SECRET`; rotate that secret only with a planned forced logout and MFA reset.
Protect recovery codes as credentials and never store them in chat, source control, or logs.

The TGS renderer uses Lottie's light canvas build, which excludes the expression engine and allows a
`script-src 'self'` policy without `unsafe-eval`. Uploaded TGS validation also rejects expressions and
external assets. The production-bundle regression test fails if `eval()` or `new Function()` returns.


## Passwords are not recoverable (by design)

There is no "forgot password" flow and no admin tool to reset a user's password. This is deliberate: it leaves no back door into an account, neither for an attacker nor for the server operator. Users are warned at signup. A user who loses the password has to create a new account; old end-to-end encrypted messages cannot be recovered without the key backup.

---

## خلاصهٔ فارسی (Persian summary)

توضیح کامل و ساده‌تر: [docs/fa/security.md](docs/fa/security.md)

- گفتگوهای مستقیم و «پیام‌های ذخیره‌شده» سرتاسر رمز (E2EE) هستند. در «حالت خودکار» (پیش‌فرض) مدیر سرور در اصل می‌تواند آن‌ها را باز کند (پایین را ببینید)؛ در «حالت امنیت بیشتر» نمی‌تواند.
- کانال‌ها سرتاسر رمز **نیستند**: کلید هر کانال روی سرور نگه‌داری می‌شود و مدیر سرور می‌تواند پست‌های کانال را بخواند.
- رمز عبور قابل بازیابی نیست. عمداً «فراموشی رمز» و ابزار ریست مدیر وجود ندارد؛ این کار راه نفوذ پشتی را می‌بندد. اگر رمز را گم کنید باید حساب تازه بسازید.
- **حالت خودکار (پیش‌فرض):** کلید رمزنگاری شما در مرورگر با رمز عبورتان قفل می‌شود و فقط نسخهٔ قفل‌شده روی سرور می‌ماند. در مرورگر یا گوشی جدید با همان رمز وارد شوید تا پیام‌های قدیمی خودکار باز شوند. بهای این راحتی: رمز عبور هنگام ورود به سرور می‌رسد، پس مدیر سرور می‌تواند (با دستکاری سرور) نسخهٔ قفل‌شده را باز کند. اگر کسی فقط دیتابیس را بردارد، با رمز قوی و هزینهٔ زیاد PBKDF2 حدس زدن رمز عملاً ممکن نیست.
- **حالت امنیت بیشتر (اختیاری، از تنظیمات):** نسخهٔ سرور پاک می‌شود و فقط شما با «کلید بازیابی» یا فایل پشتیبان می‌توانید پیام‌های قبلی را در دستگاه جدید باز کنید. مدیر سرور هیچ راهی ندارد؛ ولی اگر کلید بازیابی گم شود، پیام‌های قبلی برای همیشه از دست می‌روند.
- «شروع تازه» یک کلید جدید می‌سازد؛ پیام‌های رمزشدهٔ قبلی در آن گفتگوها برای هر دو طرف ناخواناست.
- ثبت‌نام باز به‌طور پیش‌فرض خاموش است (`OPEN_REGISTRATION`) و ثبت‌نام و ورود محدودیت تعداد تلاش دارند.
- رویدادهای حضور (آنلاین و آخرین بازدید) فقط به مخاطبی در گفت‌وگوی مستقیم دونفره می‌رسند که خود کاربر قبلاً برای او پیام فعال فرستاده باشد. ساخت یک‌طرفهٔ گفتگو یا عضویت گروه، مجوز دیدن حضور ایجاد نمی‌کند.
- گزارش آسیب‌پذیری: از بخش «Report a vulnerability» (Private advisories) در صفحهٔ GitHub پروژه استفاده کنید؛ لطفاً مشکل را عمومی منتشر نکنید.

