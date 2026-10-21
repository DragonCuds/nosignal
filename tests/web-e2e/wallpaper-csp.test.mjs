// Regression: the chat wallpaper is shown from a blob: URL (CSS background-image). The live server's CSP had
// img-src 'self' data: only, so Chromium blocked it and the wallpaper never appeared.
// Static part: the server CSP must allow blob: images. Browser part: with that CSP a blob image really loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import http from 'node:http';

const src = readFileSync(new URL('../../apps/server/src/index.ts', import.meta.url), 'utf8');
const m = src.match(/'img-src':\s*\[([^\]]*)\]/);

test('server CSP allows blob: in img-src', () => {
  assert.ok(m, 'img-src directive must be set explicitly');
  assert.match(m[1], /blob:/);
});

test('blob image loads under that CSP in a real browser', { skip: !existsSync('/snap/bin/chromium') }, async () => {
  const { default: puppeteer } = await import('puppeteer-core');
  const imgSrc = m[1].replace(/['"]/g, '').split(',').map((s) => s.trim()).join(' ');
  const srv = http.createServer((_, res) => {
    res.setHeader('content-security-policy', `default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src ${imgSrc}`);
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><body></body>');
  }).listen(0);
  const browser = await puppeteer.launch({ executablePath: '/snap/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    const ok = await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = c.height = 4;
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const url = URL.createObjectURL(blob);
      return new Promise((r) => { const i = new Image(); i.onload = () => r(true); i.onerror = () => r(false); i.src = url; });
    });
    assert.equal(ok, true);
  } finally { await browser.close(); srv.close(); }
});
