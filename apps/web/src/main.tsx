import { createRoot } from 'react-dom/client';
import { registerTgSticker } from '@tel-messenger/stickers';
import App from './App.js';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/chat.css';
import './styles/panels.css';
import './styles/zoomlock.css';
import './styles/viewport.css';
import './styles/wallpaper.css';
import './styles/media-library.css';
import { installZoomLock } from './zoomLock.js';
import { installViewportFix } from './viewportFix.js';
import { loadWallpaper } from './wallpaper/wallpaper.js';

registerTgSticker();
installZoomLock();
installViewportFix();
void loadWallpaper();

createRoot(document.getElementById('root')!).render(<App />);
