import { configureTgSticker, registerTgSticker } from '../dist/index.js';
registerTgSticker();
configureTgSticker({ maxPlaying: 12 });
const grid = document.querySelector<HTMLDivElement>('#grid')!;
const assets = ['pulse.tgs', 'orbit.tgs', 'spark.tgs'];
for (let index = 0; index < 30; index += 1) {
  const card = document.createElement('article'); card.className = 'card';
  const sticker = document.createElement('tg-sticker');
  sticker.setAttribute('src', `./assets/${assets[index % assets.length]}`); sticker.setAttribute('format', 'tgs'); sticker.setAttribute('size', '112'); sticker.setAttribute('autoplay', ''); sticker.setAttribute('loop', ''); sticker.setAttribute('alt', `CC0 demo sticker ${index + 1}`);
  const label = document.createElement('span'); label.textContent = `Sticker ${index + 1}`;
  card.append(sticker, label); grid.append(card);
}
const fps = document.querySelector<HTMLOutputElement>('#fps')!;
let frames = 0; let startedAt = performance.now();
function measure(now: number): void { frames += 1; if (now - startedAt >= 1000) { fps.value = `FPS: ${Math.round((frames * 1000) / (now - startedAt))}`; frames = 0; startedAt = now; } requestAnimationFrame(measure); }
requestAnimationFrame(measure);
