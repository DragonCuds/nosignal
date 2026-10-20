declare module 'lottie-web/build/player/esm/lottie_light_canvas.min.js' {
  import type { AnimationItem } from 'lottie-web';

  const lottieWeb: {
    loadAnimation(config: Record<string, unknown>): AnimationItem;
  };

  export default lottieWeb;
}
