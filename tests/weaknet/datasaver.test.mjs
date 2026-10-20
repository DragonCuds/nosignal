// Data-saver poor-link rule (apps/web datasaver.ts): measured RTT/throughput wins over browser hints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const m = await import('../../apps/web/src/datasaver.ts');
test('poor-link rule and data-saver state', () => {
  const t = Date.now();
  const S = (bytes, ms) => ({ bytes, ms, at: t });
  assert.equal(m.isPoorLink([]), false);
  assert.equal(m.isPoorLink([], { saveData: true }), true);
  assert.equal(m.isPoorLink([], { effectiveType: '2g' }), true);
  assert.equal(m.isPoorLink([], { effectiveType: '4g' }), false);
  assert.equal(m.isPoorLink([S(500, 2000), S(600, 1800), S(400, 1700)]), true);        // slow RTT
  assert.equal(m.isPoorLink([S(500, 300), S(600, 400), S(400, 350)]), false);
  assert.equal(m.isPoorLink([S(262160, 10000), S(262160, 9000), S(262160, 8000)]), true); // ~26 KB/s
  assert.equal(m.isPoorLink([S(262160, 2000), S(262160, 2000), S(262160, 2000)]), false); // 128 KB/s
  assert.equal(m.isPoorLink([S(500, 300), S(600, 400), S(400, 350)], { saveData: true }), false); // measured wins
  assert.equal(m.isPoorLink([S(500, 2000), S(600, 1800)]), false); // too few samples
  assert.equal(m.isPoorLink([{ ...S(500, 2000), at: t - 10 * 60_000 }, S(600, 1800), S(400, 1700)]), false); // stale dropped
  // stateful
  m.__resetDataSaver();
  assert.equal(m.getDataSaver(), 'auto');
  for (let i = 0; i < 3; i++) m.reportTransfer(262160, 10000);
  m.setDataSaver('off'); assert.equal(m.getDataSaver(), 'off');
  m.setDataSaver('on'); assert.equal(m.getDataSaver(), 'on');
});
