// Regression: decrypted chat media (video, audio, images) plays from blob: URLs, so the CSP must allow them.
// Without media-src blob: a sent video shows controls but never plays (default-src 'self' blocks blob:).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const src = readFileSync(new URL('../../apps/server/src/index.ts', import.meta.url), 'utf8');
const directive = (name) => new RegExp(`'${name}':\\s*\\[([^\\]]*)\\]`).exec(src)?.[1] ?? '';

test('CSP lets the page play and show blob: media', () => {
  assert.match(directive('media-src'), /'self'/);
  assert.match(directive('media-src'), /blob:/);
  assert.match(directive('img-src'), /blob:/);
  assert.match(directive('connect-src'), /blob:/);
});

test('video bubbles still use a blob: source', () => {
  const bubble = readFileSync(new URL('../../apps/web/src/chat/FileBubble.tsx', import.meta.url), 'utf8');
  assert.match(bubble, /<video[^>]*src=\{url\}/);
});
