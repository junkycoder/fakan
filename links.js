// Dispatch externích odkazů (uzly typu .url ve stromu).
// Soubor *.url v content repu = jeden řádek s URL targetem.
// Klik / Enter / Space → otevři podle schématu.

import { showTipDialog } from './sources.js';

export function openLink(node) {
  const href = (node && node.href || '').trim();
  if (!href) return;
  if (href === 'fakan:tip') { showTipDialog(); return; }
  if (href.startsWith('mailto:') || href.startsWith('tel:')) {
    window.location.href = href;
    return;
  }
  window.open(href, '_blank', 'noopener,noreferrer');
}

// Helper pro tree-buildery: rozhodne, jestli soubor je .url,
// a vrátí parsovaný (kind, href, displayName). Jinak null.
export function parseUrlFile(name, rawText) {
  if (!name.toLowerCase().endsWith('.url')) return null;
  const href = (rawText || '').trim().split('\n')[0].trim();
  // Vizuální šipka v názvu — hit zóna i layout grid se podle name dimenzují,
  // takže šipka musí být v name, ne jen v CSS ::after.
  return {
    kind: 'link',
    href,
    displayName: `${name.slice(0, -4)} ↗`,
  };
}
