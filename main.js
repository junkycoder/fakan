// fakan.cz — vstupní bod, spustí boot orchestraci.
//
// Architektura modulů (závislosti tečou shora dolů):
//   main.js → boot.js → keyboard.js → panels.js → mindmap.js → state.js
//                    → sources.js  → panels.js + mindmap.js
// Žádné cykly. Sdílený stav v `state.js` (singleton object).

import { boot } from './boot.js';
import { state } from './state.js';

// Hook pro e2e testy (Playwright). Žádný runtime cost, žádná závislost v produkci.
window.__fakan = { state };

// Vypnout nativní pinch-to-zoom celé stránky (koliduje s app zoomem na iOS Safari/Arc).
// Viewport meta sám o sobě nestačí — WebKit respektuje až kombinaci s gesture eventy.
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });

boot().catch((err) => {
  console.error(err);
  const map = document.getElementById('map');
  if (map) map.textContent = `chyba: ${err.message}`;
});
