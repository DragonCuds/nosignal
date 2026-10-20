# معماری (خلاصه برای توسعه‌دهنده)

مخزن یک monorepo با npm workspaces است.

## ساختار

- `apps/server`: سرور (Node.js 24، TypeScript، Fastify، SQLite با better-sqlite3).
- `apps/web`: برنامهٔ وب (React، Vite، TypeScript). فارسی و راست‌به‌چپ.
- `packages/media-contract`: نوع‌ها و ثابت‌های مشترک رسانه و پیوست.
- `packages/stickers`: کد مربوط به استیکرها.
- `deploy/`: قالب سرویس systemd.
- `scripts/`: نصب، پشتیبان، آپدیت، تولید فایل‌های ایموجی، بررسی مجوزها.
- `tests/`: آزمون‌ها (`node --test`).
- `docs/`: طراحی‌ها (انگلیسی). TODO-verify: بعضی از این طراحی‌ها (مثلاً گروه) هنوز پیاده نشده‌اند.

## سرور

فایل‌های مهم در `apps/server/src`:

- `index.ts`: ساخت سرور Fastify، مسیرها، فایل‌های ایستا.
- `config.ts`: خواندن متغیرهای محیطی و `.env`.
- `db.ts`, `migrate.ts` و پوشهٔ `apps/server/migrations/*.sql`: دیتابیس و مهاجرت‌ها. جزئیات: [DB.md](../DB.md).
- `auth.ts`, `totp.ts`, `security.ts`: ورود، نشست، ورود دومرحله‌ای، کلید عبور.
- `registration.ts`, `invites.ts`, `users.ts`: ثبت‌نام باز، لینک دعوت، کاربران.
- `chats.ts`, `encrypted-message.ts`, `crypto.ts`: گفتگوها، پیام رمزشده، پاکت‌های کلید.
- `channels.ts`: کانال‌ها. [CHANNELS.md](../CHANNELS.md)
- `attachments/`: بارگذاری و دانلود تکه‌ای فایل رمزشده. [ATTACHMENTS.md](../ATTACHMENTS.md)
- `media/`: بستهٔ استیکر و گیف کاربر.
- `realtime.ts`, `sync.ts`: رویدادهای زنده (WebSocket یا SSE) و همگام‌سازی.
- `tls.ts`: حالت HTTPS داخلی.
- `cli/user-add.ts`: ساخت کاربر و ادمین از خط فرمان.

دیتابیس: یک فایل `tel.db` در `DATA_DIR` با حالت WAL. نوشتن‌ها با تراکنش و `BEGIN IMMEDIATE`. شناسه‌ها در API رشتهٔ عددی هستند.

## وب

در `apps/web/src`:

- `App.tsx`, `Sidebar.tsx`, `Conversation.tsx`, `chat/`: رابط اصلی.
- `e2ee.ts`: ساخت و نگهداری کلید هویت (P-256 در IndexedDB؛ قابل خروج برای پشتیبان‌گیری)، ECDH + HKDF، AES-256-GCM.
- `attachments/`: آماده‌سازی عکس (کوچک‌سازی)، رمزنگاری تکه‌ای و بارگذاری.
- `outbox.ts`, `sync.ts`, `realtime.ts`, `db.ts`: صف ارسال ماندگار، همگام‌سازی، اتصال زنده، کش محلی.
- `datasaver.ts`: حالت صرفه‌جویی و تشخیص اتصال ضعیف.
- `backup/`: پشتیبان کلید: حالت خودکار (قفل‌شده با رمز عبور، `serverBackup.ts`، سرور `cryptoBackup.ts`)، حالت امنیت بیشتر (کلید بازیابی/فایل) و صفحهٔ `RecoveryScreen`.
- `channels/`, `join/`, `settings/`, `media/`, `wallpaper/`: بخش‌های مربوطه.
- `public/service-worker.js`, `manifest.webmanifest`: PWA و کار آفلاین.

## چگونه پیام رمز می‌شود

1. هر کاربر کلید هویت دارد؛ بخش عمومی‌اش را به سرور می‌دهد.
2. هر گفتگو یک کلید دارد که برای هر عضو با ECDH + HKDF + AES-GCM «پاکت» می‌شود.
3. پیام در مرورگر با کلید گفتگو رمز می‌شود. داده‌های احراز (AAD) پیام را به گفتگو، فرستنده، شناسهٔ رمز و نوع پیام می‌بندد.
4. هر شناسهٔ رمز یک‌بار قابل استفاده است تا پیام ضبط‌شده دوباره ارسال نشود.
5. فایل‌ها با کلید تصادفی خودشان تکه‌تکه (۲۵۶ کیبی‌بایت) رمز می‌شوند و کلیدشان داخل پیام رمزشده است.
6. کانال استثناست: کلید کانال را سرور نگه می‌دارد.

جزئیات کامل: [SECURITY.md](../../SECURITY.md).

## طراحی برای شبکهٔ ضعیف

- شناسهٔ پیام که کلاینت می‌سازد (جلوی ارسال دوباره را می‌گیرد).
- صف ارسال در IndexedDB با تلاش دوباره.
- همگام‌سازی با نشانگر آخرین رویداد.
- ضربان‌سنج و اتصال دوباره.
- بارگذاری تکه‌ای با ازسرگیری.
- فشرده‌سازی پاسخ‌ها (نه برای متن رمزشده).
- سرو فایل‌های ایستا و ایموجی از خود سرور.

[WEAK-NET.md](../WEAK-NET.md) هم تحقیق و هم فهرست مشکلات اولیه است؛ بعضی از آن موارد حالا رفع شده‌اند. TODO-verify: کدام موارد دقیقاً پیاده شده.

## ساخت و اجرا

```
npm ci
npm run build
npm run migrate
npm run user:add -- admin "Admin" --admin
npm run start
```

آزمون‌ها: `npm test` و `npm run test:security`. بررسی آفلاین بودن بسته: `npm run check:offline`.
