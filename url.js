// URL sync — pathname zrcadlí aktivní soubor v main panelu.
// Žádný hash, žádný query. SPA fallback řeší _redirects pro CF Pages.

import { state } from './state.js';
import { recenter, focusNode } from './mindmap.js';

// '' → '/', 'about/zaruka.md' → '/about/zaruka.md'
// encodeURI nezakóduje '/', zakóduje diakritiku a mezery (browser je v address baru
// zase dekóduje na čitelnou podobu).
export function pathToUrl(path) {
  if (!path) return '/';
  return '/' + path.split('/').map(encodeURIComponent).join('/');
}

// '/' → '', '/about/zaruka.md' → 'about/zaruka.md'
export function urlToPath() {
  const raw = window.location.pathname || '/';
  if (raw === '/' || raw === '') return '';
  const stripped = raw.replace(/^\/+/, '').replace(/\/+$/, '');
  try {
    return stripped.split('/').map(decodeURIComponent).join('/');
  } catch {
    return '';
  }
}

// replaceState bez zbytečného přepisu (vyhne se duplikátním entries i v případě
// že někdy refaktorujeme na pushState).
export function syncUrl(path) {
  const next = pathToUrl(path);
  if (window.location.pathname === next) return;
  try {
    window.history.replaceState(null, '', next);
  } catch {
    // file:// nebo jiný kontext bez history API — ignoruj
  }
}

// Hledání nodu v plném stromu (state.byPath obsahuje jen aktuální podstrom).
// originalTree má raw nodes z tree.json (name/type/filename/children) bez path
// field — počítáme cestu ze stejných segmentů jako buildMindmap: pro file z
// `filename || name`, pro dir z `name`. Root (top-level volání) má prefix=''.
export function findNodeByPath(tree, path, prefix = null) {
  if (!tree) return null;
  // prefix === null = vrchol stromu (root) — sám se v path nepromítne
  let here;
  if (prefix === null) {
    here = '';
  } else {
    const seg = tree.type === 'file' ? (tree.filename || tree.name) : tree.name;
    here = prefix ? `${prefix}/${seg}` : seg;
  }
  if (here === path) return tree;
  // brzká zkratka — pokud path nezačíná aktuální cestou (a nejsme na rootu), nemá smysl pokračovat
  if (here && path && !path.startsWith(here + '/')) return null;
  const kids = tree.children || [];
  for (const child of kids) {
    const hit = findNodeByPath(child, path, here);
    if (hit) return hit;
  }
  return null;
}
