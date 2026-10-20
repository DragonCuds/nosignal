// Chat wallpaper pure logic (apps/web wallpaper/wallpaper.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
const m = await import('../../apps/web/src/wallpaper/wallpaper.ts');

test('clamping', () => {
  assert.equal(m.clampDim(-5), 0);
  assert.equal(m.clampDim(95), 80);
  assert.equal(m.clampDim('40'), 40);
  assert.equal(m.clampDim('abc'), 20);
  assert.equal(m.clampBlur(99), 20);
  assert.equal(m.clampBlur(-1), 0);
  assert.equal(m.clampBlur(NaN), 0);
  assert.equal(m.clampBlur(7.6), 8);
});

test('fitSize keeps ratio, max 1600, never upscales', () => {
  assert.deepEqual(m.fitSize(4000, 2000), { width: 1600, height: 800 });
  assert.deepEqual(m.fitSize(2000, 4000), { width: 800, height: 1600 });
  assert.deepEqual(m.fitSize(800, 600), { width: 800, height: 600 });
  assert.deepEqual(m.fitSize(0, 10), { width: 0, height: 0 });
  assert.deepEqual(m.fitSize(10000, 1), { width: 1600, height: 1 });
});

test('settings parse/serialise', () => {
  assert.deepEqual(m.parseSettings(null), m.DEFAULT_SETTINGS);
  assert.deepEqual(m.parseSettings('not json'), m.DEFAULT_SETTINGS);
  assert.deepEqual(m.parseSettings('null'), m.DEFAULT_SETTINGS);
  assert.deepEqual(m.parseSettings('{"dim":500,"blur":-3,"hasImage":true}'), { dim: 80, blur: 0, hasImage: true });
  assert.deepEqual(m.parseSettings('{"dim":"x","hasImage":"yes"}'), { dim: 20, blur: 0, hasImage: false });
  const s = { dim: 55, blur: 12, hasImage: true };
  assert.deepEqual(m.parseSettings(m.serialiseSettings(s)), s);
  assert.deepEqual(m.parseSettings(m.serialiseSettings({ dim: 999, blur: 999, hasImage: true })), { dim: 80, blur: 20, hasImage: true });
});

test('file validation', () => {
  assert.equal(m.validateFile({ type: 'image/png', size: 1000 }), null);
  assert.equal(m.validateFile({ type: 'image/jpeg', size: 15 * 1024 * 1024 }), null);
  assert.match(m.validateFile({ type: 'image/png', size: 15 * 1024 * 1024 + 1 }), /۱۵/);
  assert.match(m.validateFile({ type: 'application/pdf', size: 10 }), /تصویر/);
  assert.match(m.validateFile({ type: '', size: 10 }), /تصویر/);
  assert.ok(m.validateFile(null));
});

test('css vars', () => {
  const off = m.cssVars({ dim: 30, blur: 4, hasImage: false, url: null });
  assert.equal(off['--chat-wallpaper-image'], 'none');
  const on = m.cssVars({ dim: 30, blur: 4, hasImage: true, url: 'blob:x' });
  assert.equal(on['--chat-wallpaper-image'], 'url("blob:x")');
  assert.equal(on['--chat-wallpaper-dim'], '0.3');
  assert.equal(on['--chat-wallpaper-blur'], '4px');
});

test('node (no DOM) does not throw', async () => {
  const s = await m.loadWallpaper();
  assert.equal(s.hasImage, false);
  assert.equal(m.updateWallpaperSettings({ dim: 70 }).dim, 70);
  await m.clearWallpaper();
});
