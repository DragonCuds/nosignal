import { CSSProperties, useEffect, useRef, useState } from 'react';

type GifVideoProps = {
  className?: string;
  mp4Url: string;
  posterUrl?: string;
  label?: string;
  style?: CSSProperties;
};

export function GifVideo({ className, mp4Url, posterUrl, label = 'گیف', style }: GifVideoProps) {
  const video = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(document.visibilityState === 'visible');
  const [reduceMotion, setReduceMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting && entry.intersectionRatio > 0), { threshold: 0.05 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [mp4Url]);

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const visibility = () => setPageVisible(document.visibilityState === 'visible');
    const preference = () => setReduceMotion(motion.matches);
    document.addEventListener('visibilitychange', visibility);
    motion.addEventListener('change', preference);
    return () => { document.removeEventListener('visibilitychange', visibility); motion.removeEventListener('change', preference); };
  }, []);

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    if (visible && pageVisible && !reduceMotion) void element.play().catch(() => undefined);
    else { element.pause(); if (reduceMotion) element.currentTime = 0; }
  }, [pageVisible, reduceMotion, visible, mp4Url]);

  return <video ref={video} className={className} src={mp4Url} poster={posterUrl} muted loop playsInline preload="metadata" aria-label={label} style={style} data-gif-video />;
}
