import { useState } from 'react';
import { canPostpone, needsWarning, postpone, postponesUsed, MAX_POSTPONES } from './reminder.js';

/** Strong first-login warning. onBackup should open Settings → «پشتیبان کلید». */
export function BackupWarning({ userId, onBackup }: { userId: string; onBackup: () => void }) {
  const [hidden, setHidden] = useState(false);
  if (hidden || !needsWarning(userId)) return null;
  const left = MAX_POSTPONES - postponesUsed(userId);
  return (
    <div role="alertdialog" aria-label="هشدار پشتیبان کلید" dir="rtl" style={{ padding: 16 }}>
      <strong>پیام‌های شما فقط با کلید روی همین دستگاه خوانده می‌شوند.</strong>
      <p>اگر مرورگر پاک شود یا گوشی را عوض کنید، همهٔ پیام‌های قبلی برای همیشه از دست می‌روند. همین حالا از کلید خود پشتیبان بگیرید.</p>
      <button type="button" onClick={onBackup}>پشتیبان‌گیری</button>{' '}
      {canPostpone(userId)
        ? <button type="button" onClick={() => { postpone(userId); setHidden(true); }}>بعداً یادآوری کن ({left} بار مانده)</button>
        : <small>دیگر نمی‌توان به تعویق انداخت.</small>}
    </div>
  );
}
