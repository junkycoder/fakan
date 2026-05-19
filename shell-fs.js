// VFS adapter nad state.byPath + state.childrenByPath + edit overlay.
// Iterace 1: čtení (resolve, stat, readdir, readFile).
// Iterace 2: zápis (mkdir, touch, rm, writeFile) přes addTreeNode/removeTreeNode
// v mindmap.js a saveEditOverride v state.js — overlay v localStorage.

import { state, applyEditToNode, saveEditOverride, LS_EDIT_PREFIX } from './state.js';
import { addTreeNode, removeTreeNode, rebuildMindmap } from './mindmap.js';

export function normalizeCwd(cwd) {
  return String(cwd || '').replace(/^\/+|\/+$/g, '');
}

// Resolve cíle vůči cwd. Podporuje absolutní (/foo), ~ expanzi, ../ a ./ segmenty.
export function resolvePath(cwd, target) {
  let t = String(target || '');
  if (t === '' || t === '.') return normalizeCwd(cwd);
  if (t === '~') return '';
  if (t.startsWith('~/')) t = t.slice(2);
  if (t.startsWith('/')) return t.replace(/^\/+|\/+$/g, '');
  const parts = normalizeCwd(cwd).split('/').filter(Boolean);
  for (const seg of t.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

export function stat(path) {
  const p = path || '';
  const node = state.byPath.get(p);
  if (!node) return null;
  return {
    path: p,
    name: node.name,
    type: node.type === 'file' ? 'file' : 'dir',
    kind: node.kind,
    node,
  };
}

export function readdir(path) {
  const p = path || '';
  if (!state.byPath.get(p) && p !== '') return null;
  const kids = state.childrenByPath.get(p) || [];
  return kids.map((c) => ({
    name: c.name,
    type: c.type === 'file' ? 'file' : 'dir',
    path: c.path || '',
  }));
}

export function exists(path) {
  if (!path) return true; // root
  return state.byPath.has(path);
}

export function isDir(path) {
  if (!path) return true; // root
  const s = stat(path);
  return !!(s && s.type === 'dir');
}

export function parentOf(path) {
  const p = String(path || '');
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function basenameOf(path) {
  const p = String(path || '');
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

// Pokud nemáme raw v paměti, dotáhneme přes node.path (statický deploy) nebo
// node._handle (FSA). Pro snapshot / GitHub by mělo být v paměti.
export async function readFile(path) {
  const s = stat(path);
  if (!s) return null;
  if (s.type !== 'file') throw new Error('je adresář');
  const n = s.node;
  if (n.raw != null) return n.raw;
  if (n.content != null) return n.content;
  if (n._handle && typeof n._handle.getFile === 'function') {
    try {
      const file = await n._handle.getFile();
      const text = await file.text();
      n._originalRaw = text;
      n.raw = text;
      return text;
    } catch (e) { return null; }
  }
  if (n.path) {
    try {
      const res = await fetch(encodeURI(n.path));
      if (!res.ok) return null;
      const text = await res.text();
      n._originalRaw = text;
      n.raw = text;
      return text;
    } catch (e) { return null; }
  }
  return null;
}

// --- write API -------------------------------------------------------------
// Mutuje originalTree přes addTreeNode/removeTreeNode (které loggují op
// do LS přes pushTreeOp) a obsah souborů přes saveEditOverride. Volá
// rebuildMindmap, aby se index byPath / childrenByPath aktualizoval a
// nová položka byla hned vidět v mindmapě.

function refreshIndex() {
  rebuildMindmap(state.currentRootPath, { keepViewport: true });
}

// Sanitace názvu — addTreeNode už totéž dělá, ale chci vrátit konkrétní
// chybu pro shell, ne null.
function validateName(name) {
  if (!name) return 'prázdné jméno';
  if (name === '.' || name === '..') return `vyhrazené jméno: ${name}`;
  if (name.includes('/')) return `lomítko ve jméně: ${name}`;
  return null;
}

export function mkdir(path) {
  if (!path) throw new Error('mkdir: chybí cesta');
  if (exists(path)) {
    const s = stat(path);
    if (s.type === 'dir') return { created: false, reason: 'existuje' };
    throw new Error(`existuje jako soubor: ${path}`);
  }
  const parent = parentOf(path);
  const name = basenameOf(path);
  const reason = validateName(name);
  if (reason) throw new Error(reason);
  if (parent && !exists(parent)) throw new Error(`složka neexistuje: ${parent}`);
  if (parent && !isDir(parent)) throw new Error(`není adresář: ${parent}`);
  const created = addTreeNode(parent, name + '/');
  if (!created) throw new Error(`nelze vytvořit ${path}`);
  refreshIndex();
  return { created: true };
}

// mkdir -p: vytvoří všechny mezičlánky bez chyby na existující.
export function mkdirP(path) {
  if (!path) return { created: false };
  const parts = path.split('/').filter(Boolean);
  let cur = '';
  let anyCreated = false;
  for (const seg of parts) {
    const next = cur ? `${cur}/${seg}` : seg;
    if (!exists(next)) {
      const res = mkdir(next);
      if (res.created) anyCreated = true;
    } else if (!isDir(next)) {
      throw new Error(`není adresář: ${next}`);
    }
    cur = next;
  }
  return { created: anyCreated };
}

export function touchFile(path) {
  if (!path) throw new Error('touch: chybí cesta');
  if (exists(path)) {
    const s = stat(path);
    if (s.type === 'dir') throw new Error(`je adresář: ${path}`);
    return { created: false }; // bash touch na existující = no-op (mtime by změnil, ale to nesimulujeme)
  }
  const parent = parentOf(path);
  const name = basenameOf(path);
  const reason = validateName(name);
  if (reason) throw new Error(reason);
  if (parent && !exists(parent)) throw new Error(`složka neexistuje: ${parent}`);
  if (parent && !isDir(parent)) throw new Error(`není adresář: ${parent}`);
  const created = addTreeNode(parent, name);
  if (!created) throw new Error(`nelze vytvořit ${path}`);
  refreshIndex();
  return { created: true };
}

// rm: pro adresář vyžaduje recursive flag. Vyčistí i edit-overlay
// sirotky v localStorage pro mazaný subtree.
export function removePath(path, { recursive = false } = {}) {
  if (!path) throw new Error('rm: chybí cesta');
  const s = stat(path);
  if (!s) throw new Error(`neexistuje: ${path}`);
  if (s.type === 'dir') {
    const kids = readdir(path) || [];
    if (kids.length && !recursive) throw new Error(`je adresář (přidejte -r): ${path}`);
    // posbírej overlay sirotky před rebuildem
    if (recursive) cleanupEditOverlay(path);
  }
  const ok = removeTreeNode(path);
  if (!ok) throw new Error(`nelze smazat: ${path}`);
  refreshIndex();
  return { removed: true };
}

function cleanupEditOverlay(dirPath) {
  const prefix = LS_EDIT_PREFIX + dirPath + '/';
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {}
}

// Zápis textu do souboru. Pokud neexistuje, vytvoří ho v rodičovské složce.
// Pokud existuje jako adresář, hodí chybu.
export function writeFile(path, content) {
  if (!path) throw new Error('chybí cesta');
  const text = String(content == null ? '' : content);
  let s = stat(path);
  if (!s) {
    touchFile(path);
    s = stat(path);
    if (!s) throw new Error(`neuspěl create: ${path}`);
    // fresh-created uzel: _originalRaw = '' aby reset v editoru znamenal prázdno
    s.node._originalRaw = '';
  }
  if (s.type !== 'file') throw new Error(`není soubor: ${path}`);
  applyEditToNode(s.node, text);
  saveEditOverride(s.node, text);
  return { written: true, bytes: text.length };
}

// cp / mv pro file → file. Pro dir → dir bude potřeba rekurze (iterace 3).
export async function copyFile(src, dst) {
  const text = await readFile(src);
  if (text == null) throw new Error(`nelze přečíst: ${src}`);
  writeFile(dst, text);
}

export async function movePath(src, dst) {
  const s = stat(src);
  if (!s) throw new Error(`neexistuje: ${src}`);
  if (s.type === 'dir') throw new Error('mv adresáře zatím nepodporováno');
  await copyFile(src, dst);
  removePath(src);
}
