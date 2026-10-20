import type { DetailedHTMLProps, HTMLAttributes } from 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'tg-sticker': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        format?: 'tgs' | 'webm' | 'webp';
        size?: string | number;
        autoplay?: boolean;
        loop?: boolean;
        alt?: string;
      };
    }
  }
}
