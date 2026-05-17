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

boot().catch((err) => {
  console.error(err);
  const map = document.getElementById('map');
  if (map) map.textContent = `chyba: ${err.message}`;
});
