// URL sync — pathname zrcadlí stav aplikace.
//
// Pravidla:
//   • main panel je otevřený → URL = cesta toho souboru (např. /about/zaruka.md)
//   • main zavřený, recenter na dir → URL = cesta dir + trailing slash (/projects/)
//   • home, nic → /
//
// Změny stavu (klik na file, recenter, close panelu) → history.pushState,
// aby Back/Forward nativně přeskakoval mezi stavy. Identická URL = bez entry.
//
// Edge case: pokud je main panel mimo recenter subtree (uživatel recenter na
// `about`, ale main drží `projects/foo.md`), URL ukáže main (full path) — to
// stačí pro reload, recenter v tomto případě URL nezmění.

import { state } from './state.js';

// 'about/zaruka.md' → '/about/zaruka.md', '' → '/'. Trailing '/' přidá volající
// pro dir-only URL.
export function pathToUrl(path) {
  if (!path) return '/';
  return '/' + path.split('/').map(encodeURIComponent).join('/');
}

// Vypočítá URL z (rootPath, mainPath). Trailing slash = dir-only stav.
export function computeUrl(rootPath, mainPath) {
  if (mainPath) return pathToUrl(mainPath);
  if (rootPath) return pathToUrl(rootPath) + '/';
  return '/';
}

// Parsuje location.pathname → { path, isDir }
//   '/' → { path: '', isDir: false }
//   '/projects/' → { path: 'projects', isDir: true }
//   '/about/zaruka.md' → { path: 'about/zaruka.md', isDir: false }
export function parseUrl() {
  const raw = window.location.pathname || '/';
  if (raw === '/' || raw === '') return { path: '', isDir: false };
  const isDir = raw.endsWith('/') && raw.length > 1;
  const stripped = raw.replace(/^\/+/, '').replace(/\/+$/, '');
  try {
    const path = stripped.split('/').map(decodeURIComponent).join('/');
    return { path, isDir };
  } catch {
    return { path: '', isDir: false };
  }
}

// Pushne nový stav do history. No-op pokud URL je identická.
export function pushUrl(rootPath, mainPath) {
  const next = computeUrl(rootPath, mainPath);
  const current = window.location.pathname;
  if (current === next) return;
  try {
    window.history.pushState(null, '', next);
  } catch {}
}

// replaceState — pro init z URL (nahradí null entry před uživatelovou
// navigací), nebo pro tichou opravu.
export function replaceUrl(rootPath, mainPath) {
  const next = computeUrl(rootPath, mainPath);
  const current = window.location.pathname;
  if (current === next) return;
  try {
    window.history.replaceState(null, '', next);
  } catch {}
}

// Pohodlný wrapper: čte rootPath/mainPath ze state, sám se rozhodne push/replace.
// Default = push (uživatelská akce). Pass `{ replace: true }` pro init.
export function syncFromState({ replace = false } = {}) {
  const rootPath = state.currentRootPath || '';
  const mainPath = state.mainPanel?.path || '';
  if (replace) replaceUrl(rootPath, mainPath);
  else pushUrl(rootPath, mainPath);
}

// Hledání nodu v plném stromu (state.byPath obsahuje jen aktuální podstrom).
// originalTree má raw nodes z tree.json (name/type/filename/children) bez path
// field — počítáme cestu ze stejných segmentů jako buildMindmap: pro file z
// `filename || name`, pro dir z `name`. Root (top-level volání) má prefix=''.
export function findNodeByPath(tree, path, prefix = null) {
  if (!tree) return null;
  let here;
  if (prefix === null) {
    here = '';
  } else {
    const seg = tree.type === 'file' ? (tree.filename || tree.name) : tree.name;
    here = prefix ? `${prefix}/${seg}` : seg;
  }
  if (here === path) return tree;
  if (here && path && !path.startsWith(here + '/')) return null;
  const kids = tree.children || [];
  for (const child of kids) {
    const hit = findNodeByPath(child, path, here);
    if (hit) return hit;
  }
  return null;
}
