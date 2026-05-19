// VFS adapter nad state.byPath + state.childrenByPath + edit overlay.
// Iterace 1: jen čtení (resolve, stat, readdir, readFile). Write přijde v iteraci 2.

import { state } from './state.js';

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
