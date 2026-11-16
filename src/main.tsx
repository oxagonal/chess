import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'chessground/assets/chessground.base.css';
import 'chessground/assets/chessground.brown.css';
import 'chessground/assets/chessground.cburnett.css';
import './styles.css';
import { App } from './App';
import { completeLichessLogin } from './services/lichessAuth';
import { startAutoSync } from './services/cloudSync';

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
// Back from lichess.org's "Connect Lichess" page? Must run before the first render (it fixes the URL).
completeLichessLogin();
// Ask the browser not to evict our IndexedDB data when the device is low on space.
navigator.storage?.persist?.().catch(() => {});
// Sync with your other devices (if connected in Settings).
void startAutoSync();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
