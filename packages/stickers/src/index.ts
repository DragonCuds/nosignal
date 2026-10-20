// The light canvas build intentionally omits Lottie's expression engine. The full build evaluates
// animation expressions with eval(), which is unnecessary for Telegram TGS files and weakens CSP.
import lottieWeb from 'lottie-web/build/player/esm/lottie_light_canvas.min.js';
import type { AnimationItem } from 'lottie-web';
import { ungzip } from 'pako';

export type TgStickerFormat = 'tgs' | 'webm' | 'webp';
export interface TgStickerConfig { maxPlaying?: number; }

type LottieData = Record<string, unknown>;
type LottiePlayer = AnimationItem;
type LottieApi = { loadAnimation(config: Record<string, unknown>): AnimationItem; };
// NodeNext reads lottie-web's CommonJS declaration as a module namespace, while Vite resolves its
// runtime default export. This narrow cast preserves the public library types without importing a
// framework-specific wrapper.
const lottie = lottieWeb as unknown as LottieApi;
const DEFAULT_SIZE = 160;
const tgsDataCache = new Map<string, Promise<LottieData>>();
const mediaPreloadCache = new Map<string, Promise<void>>();
const instances = new Set<TgStickerElement>();
const playing = new Set<TgStickerElement>();
let maxPlaying = 12;
let registered = false;
let documentListenersInstalled = false;

function absoluteUrl(source: string): string { return new URL(source, document.baseURI).href; }
function cloneLottieData(data: LottieData): LottieData {
  return typeof structuredClone === 'function' ? structuredClone(data) : JSON.parse(JSON.stringify(data)) as LottieData;
}
async function fetchTgs(url: string): Promise<LottieData> {
  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`Unable to load sticker (${response.status})`);
  const text = new TextDecoder().decode(ungzip(new Uint8Array(await response.arrayBuffer())));
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== 'object') throw new Error('The .tgs file does not contain Lottie JSON');
  return data as LottieData;
}
function loadTgs(url: string): Promise<LottieData> {
  let pending = tgsDataCache.get(url);
  if (!pending) {
    pending = fetchTgs(url).catch((error: unknown) => { tgsDataCache.delete(url); throw error; });
    tgsDataCache.set(url, pending);
  }
  return pending;
}
function reducedMotion(): boolean { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; }
function canPlay(sticker: TgStickerElement): boolean { return sticker.canPlay && !document.hidden && !reducedMotion(); }
function reschedule(): void {
  for (const sticker of [...playing]) {
    if (!canPlay(sticker) || playing.size > maxPlaying) { playing.delete(sticker); sticker.pausePlayback(); }
  }
  for (const sticker of instances) {
    if (playing.size >= maxPlaying) break;
    if (canPlay(sticker) && !playing.has(sticker) && sticker.startPlayback()) playing.add(sticker);
  }
}
function installDocumentListeners(): void {
  if (documentListenersInstalled) return;
  documentListenersInstalled = true;
  document.addEventListener('visibilitychange', reschedule, { passive: true });
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', reschedule);
}

/** Sets the global concurrent playback cap; its exact default is 12. */
export function configureTgSticker(config: TgStickerConfig): void {
  if (config.maxPlaying !== undefined) {
    if (!Number.isInteger(config.maxPlaying) || config.maxPlaying < 1) throw new RangeError('maxPlaying must be an integer of at least 1');
    maxPlaying = config.maxPlaying;
  }
  reschedule();
}
export function getTgStickerConfig(): Required<TgStickerConfig> { return { maxPlaying }; }
/** Warms browser cache; TGS files are additionally decompressed and parsed once per URL. */
export function preload(source: string): Promise<void> {
  const url = absoluteUrl(source);
  if (/\.tgs(?:$|[?#])/i.test(url)) return loadTgs(url).then(() => undefined);
  let pending = mediaPreloadCache.get(url);
  if (!pending) {
    pending = fetch(url, { cache: 'force-cache' }).then((response) => {
      if (!response.ok) throw new Error(`Unable to preload sticker (${response.status})`);
    }).catch((error: unknown) => { mediaPreloadCache.delete(url); throw error; });
    mediaPreloadCache.set(url, pending);
  }
  return pending;
}

export class TgStickerElement extends HTMLElement {
  static get observedAttributes(): string[] { return ['src', 'format', 'size', 'autoplay', 'loop', 'alt']; }
  private readonly media = document.createElement('div');
  private readonly observer: IntersectionObserver | undefined;
  private lottiePlayer?: LottiePlayer;
  private video?: HTMLVideoElement;
  private visible = false;
  private loadId = 0;
  private loaded = false;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `:host { display:inline-block; width:var(--tg-sticker-size, ${DEFAULT_SIZE}px); height:var(--tg-sticker-size, ${DEFAULT_SIZE}px); vertical-align:middle; contain:content; } .media, .media > *, canvas { display:block; width:100%; height:100%; object-fit:contain; }`;
    this.media.className = 'media';
    shadow.append(style, this.media);
    this.observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver((entries) => {
      this.visible = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0);
      reschedule();
    }, { threshold: 0.01 });
  }

  get canPlay(): boolean { return this.loaded && this.visible && this.hasAttribute('autoplay') && this.format !== 'webp'; }
  get format(): TgStickerFormat {
    const explicit = this.getAttribute('format');
    if (explicit === 'tgs' || explicit === 'webm' || explicit === 'webp') return explicit;
    const source = this.getAttribute('src') ?? '';
    if (/\.tgs(?:$|[?#])/i.test(source)) return 'tgs';
    if (/\.webm(?:$|[?#])/i.test(source)) return 'webm';
    return 'webp';
  }
  set format(value: TgStickerFormat) {
    if (value === 'tgs' || value === 'webm' || value === 'webp') this.setAttribute('format', value);
    else this.removeAttribute('format');
  }
  connectedCallback(): void {
    installDocumentListeners(); instances.add(this); this.observer?.observe(this); if (!this.observer) this.visible = true;
    this.applySize(); void this.load();
  }
  disconnectedCallback(): void {
    instances.delete(this); playing.delete(this); this.observer?.unobserve(this); this.destroyMedia(); reschedule();
  }
  attributeChangedCallback(): void {
    this.applySize(); if (this.isConnected) { void this.load(); reschedule(); }
  }
  private applySize(): void {
    const value = Number(this.getAttribute('size'));
    this.style.setProperty('--tg-sticker-size', `${Number.isFinite(value) && value > 0 ? Math.min(value, 2048) : DEFAULT_SIZE}px`);
  }
  private emitError(error: unknown): void {
    this.dispatchEvent(new CustomEvent('tg-sticker-error', { detail: error instanceof Error ? error : new Error(String(error)), bubbles: true, composed: true }));
  }
  private destroyMedia(): void {
    this.lottiePlayer?.destroy(); this.lottiePlayer = undefined;
    if (this.video) { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); this.video = undefined; }
    this.media.replaceChildren(); this.loaded = false;
  }
  private async load(): Promise<void> {
    const id = ++this.loadId; this.destroyMedia();
    const source = this.getAttribute('src'); if (!source) return;
    try {
      const url = absoluteUrl(source);
      if (this.format === 'tgs') {
        const data = await loadTgs(url); if (!this.isConnected || id !== this.loadId) return;
        this.lottiePlayer = lottie.loadAnimation({ container: this.media, renderer: 'canvas', loop: this.hasAttribute('loop'), autoplay: false, animationData: cloneLottieData(data), rendererSettings: { clearCanvas: true, progressiveLoad: true, preserveAspectRatio: 'xMidYMid meet' } });
        this.lottiePlayer.goToAndStop(0, true);
      } else if (this.format === 'webm') {
        const video = document.createElement('video');
        video.src = url; video.muted = true; video.defaultMuted = true; video.playsInline = true; video.loop = this.hasAttribute('loop'); video.preload = 'metadata';
        video.setAttribute('aria-label', this.getAttribute('alt') ?? 'Animated sticker');
        video.addEventListener('loadeddata', () => {
          if (id !== this.loadId) return;
          // A video has no reliably paintable frame before metadata arrives; seek back once it does
          // so reduced motion always exposes frame 0 instead of an arbitrary decoded frame.
          if (reducedMotion()) this.pausePlayback();
          reschedule();
        }, { once: true });
        video.addEventListener('error', () => this.emitError(new Error('Unable to play WebM sticker')), { once: true });
        this.video = video; this.media.append(video);
      } else {
        const image = document.createElement('img'); image.src = url; image.alt = this.getAttribute('alt') ?? 'Sticker'; image.decoding = 'async';
        image.addEventListener('error', () => this.emitError(new Error('Unable to load WebP sticker')), { once: true }); this.media.append(image);
      }
      this.loaded = true; if (reducedMotion()) this.pausePlayback(); reschedule();
    } catch (error) { if (id === this.loadId) this.emitError(error); }
  }
  /** @internal Used by the shared scheduler. */
  startPlayback(): boolean {
    if (!this.canPlay) return false;
    if (this.lottiePlayer) { this.lottiePlayer.play(); return true; }
    if (this.video) { void this.video.play().catch(() => undefined); return true; }
    return false;
  }
  /** @internal Used by the shared scheduler and reduced-motion policy. */
  pausePlayback(): void {
    this.lottiePlayer?.pause(); this.lottiePlayer?.goToAndStop(0, true);
    if (this.video) { this.video.pause(); if (reducedMotion() && this.video.readyState >= HTMLMediaElement.HAVE_METADATA) this.video.currentTime = 0; }
  }
}
/** Registers <tg-sticker>; safe to call repeatedly. */
export function registerTgSticker(): void {
  if (typeof window === 'undefined' || typeof customElements === 'undefined') return;
  if (!customElements.get('tg-sticker')) customElements.define('tg-sticker', TgStickerElement);
  registered = true;
}
export function isTgStickerRegistered(): boolean { return registered; }
