import { api, ApiError } from './api.js';

export const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
export const MIN_PASSWORD = 8;

export type SignupCheck = 'idle' | 'invalid' | 'checking' | 'available' | 'taken' | 'error';

/** Signup tab is shown only when the server answers the availability probe (404 = registration closed). */
export const isSignupOpen = async (): Promise<boolean> => {
  try { await api.usernameAvailable('ab'); return true; } catch { return false; }
};

export const checkUsername = async (name: string, signal?: AbortSignal): Promise<'available' | 'taken' | 'invalid'> => {
  const result = await api.usernameAvailable(name, signal);
  if (!result.valid) return 'invalid';
  return result.available ? 'available' : 'taken';
};

/** Client-side validation; returns a Persian message or '' when the form is fine. */
export const validateSignup = (username: string, password: string, repeat: string): string => {
  if (!USERNAME_RE.test(username)) return 'آیدی باید ۳ تا ۳۲ حرف انگلیسی کوچک، عدد یا _ باشد.';
  if (password.length < MIN_PASSWORD) return 'رمز عبور باید حداقل ۸ نویسه باشد.';
  if (password.length > 1024) return 'رمز عبور خیلی بلند است.';
  if (password !== repeat) return 'رمز عبور و تکرار آن یکسان نیست.';
  return '';
};

export const signupErrorText = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (error.status === 409) return 'این آیدی قبلاً گرفته شده است.';
    if (error.status === 400) return 'آیدی یا رمز عبور معتبر نیست. آیدی را انگلیسی و رمز را حداقل ۸ نویسه بنویسید.';
    if (error.status === 404) return 'ثبت‌نام در حال حاضر باز نیست.';
    if (error.status === 429) return 'تلاش‌های زیادی انجام شد. چند دقیقه بعد دوباره امتحان کنید.';
    if (error.status === 0) return error.message;
  }
  return 'ساخت حساب انجام نشد. دوباره تلاش کنید.';
};

export async function registerAccount(username: string, password: string, displayName: string): Promise<void> {
  await api.register(username, password, displayName.trim() || undefined);
}
