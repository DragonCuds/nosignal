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
  // The player lives in VideoPlayer.tsx (FileBubble.tsx is only the download fallback).
  const player = readFileSync(new URL('../../apps/web/src/chat/VideoPlayer.tsx', import.meta.url), 'utf8');
  // The decrypted bytes become an object URL (blob:) ...
  assert.match(player, /const url = useBlobUrl\(blob\b/);
  assert.match(readFileSync(new URL('../../apps/web/src/attachments/load.ts', import.meta.url), 'utf8'), /URL\.createObjectURL\(/);
  // ... and that URL is the only thing the <video> element plays; no server address goes into src.
  const tag = /<video\s[\s\S]*?\n\s*\/>/.exec(player)?.[0] ?? '';
  const srcs = [...tag.matchAll(/\bsrc=(\{`[^`]*`\}|\{[^}]*\}|"[^"]*"|'[^']*')/g)].map((m) => m[1]);
  assert.equal(srcs.length, 1, 'exactly one src on the <video> element');
  assert.match(srcs[0], /^\{`\$\{url\}[^`]*`\}$|^\{url\}$/);
  assert.doesNotMatch(tag, /\/api\/|https?:/);
});
