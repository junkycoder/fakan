// Globální hledání v aktuálním zdroji — názvy + obsah najednou.
// Otevírá se z badge v pravém horním rohu („hledat") nebo Cmd/Ctrl+K.

import {
  state, escapeHtml, splitExt, isTextFile,
} from './state.js';
import { recenter } from './mindmap.js';
import { openMain } from './panels.js';

const MAX_RESULTS = 80;
const PARALLEL_FETCH = 8;
const SNIPPET_BEFORE = 36;
const SNIPPET_AFTER = 64;
const MAX_SCAN_BYTES = 1024 * 1024; // 1 MB — nad to obsah nepřejíždíme

function walkAll(tree) {
  const out = [];
  const visit = (node, here) => {
    if (!node) return;
    if (node.type === 'file') {
      out.push({ node, path: here });
      return;
    }
    if (node.type === 'dir') {
      out.push({ node, path: here, isDir: true });
    }
    for (const k of (node.children || [])) {
      const seg = k.type === 'file' ? (k.filename || k.name) : k.name;
      const next = here ? `${here}/${seg}` : seg;
      visit(k, next);
    }
  };
  visit(tree, '');
  return out;
}

function isTextItem(item) {
  const node = item.node;
  if (!node || node.type !== 'file') return false;
  const name = node.filename || node.name || '';
  const [, ext] = splitExt(name);
  return isTextFile(name, ext);
}

function matchName(item, q) {
  const node = item.node;
  const fields = [
    node.filename || node.name || '',
    node.title || '',
    item.path || '',
  ];
  for (const f of fields) {
    if (f && f.toLowerCase().includes(q)) return f;
  }
  return null;
}

function highlight(text, q) {
  if (!text) return '';
  const lc = text.toLowerCase();
  const idx = lc.indexOf(q);
  if (idx < 0) return escapeHtml(text);
  return escapeHtml(text.slice(0, idx))
    + `<mark>${escapeHtml(text.slice(idx, idx + q.length))}</mark>`
    + escapeHtml(text.slice(idx + q.length));
}

function makeSnippet(text, q) {
  const lc = text.toLowerCase();
  const idx = lc.indexOf(q);
  if (idx < 0) return '';
  const start = Math.max(0, idx - SNIPPET_BEFORE);
  const end = Math.min(text.length, idx + q.length + SNIPPET_AFTER);
  const before = text.slice(start, idx).replace(/\s+/g, ' ');
  const match = text.slice(idx, idx + q.length);
  const after = text.slice(idx + q.length, end).replace(/\s+/g, ' ');
  return (start > 0 ? '…' : '')
    + escapeHtml(before)
    + `<mark>${escapeHtml(match)}</mark>`
    + escapeHtml(after)
    + (end < text.length ? '…' : '');
}

async function fetchNodeText(node, path) {
  if (node._originalRaw != null) return node._originalRaw;
  if (node.raw != null) return node.raw;
  if (node.content != null) return node.content;
  try {
    if (node._handle && typeof node._handle.getFile === 'function') {
      const file = await node._handle.getFile();
      if (file.size > MAX_SCAN_BYTES) return null;
      const text = await file.text();
      node._originalRaw = text;
      return text;
    }
  } catch { return null; }
  if (!path) return null;
  try {
    const res = await fetch(encodeURI(path), { cache: 'force-cache' });
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > MAX_SCAN_BYTES) return null;
    const text = await res.text();
    if (text.length > MAX_SCAN_BYTES) return null;
    node._originalRaw = text;
    return text;
  } catch { return null; }
}

function openResult(item) {
  const path = item.path || '';
  if (!path) { recenter(''); return; }
  if (item.isDir) { recenter(path); return; }
  // soubor: ujisti, že je v aktuálním podstromu (jinak recenter na rodiče)
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  if (!state.byPath.has(path)) recenter(parent, { silent: true });
  const fresh = state.byPath.get(path);
  if (fresh) openMain(fresh);
}

export function showSearchDialog() {
  document.querySelector('[data-search-dialog]')?.remove();

  const wrap = document.createElement('div');
  wrap.className = 'search-dialog';
  wrap.setAttribute('data-search-dialog', '');
  wrap.innerHTML = `
    <div class="search-dialog__panel" role="dialog" aria-modal="true" aria-labelledby="search-title">
      <h2 class="search-dialog__title" id="search-title">Hledat</h2>
      <div class="search-dialog__field">
        <input type="search" class="search-dialog__input" data-search-input
               placeholder="hledat v názvech i v obsahu…" autocomplete="off" spellcheck="false" />
      </div>
      <div class="search-dialog__status" data-search-status>Zadejte hledaný výraz.</div>
      <div class="search-dialog__results" data-search-results role="listbox"></div>
      <div class="search-dialog__buttons">
        <button type="button" class="search-dialog__btn" data-search-close>Zavřít</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  const input = wrap.querySelector('[data-search-input]');
  const statusEl = wrap.querySelector('[data-search-status]');
  const resultsEl = wrap.querySelector('[data-search-results]');

  let runSeq = 0;
  let activeIdx = -1;
  let lastResults = [];

  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey, true);
  };

  const setActive = (i) => {
    activeIdx = Math.max(-1, Math.min(lastResults.length - 1, i));
    const btns = resultsEl.querySelectorAll('.search-dialog__result');
    btns.forEach((b, k) => b.classList.toggle('is-active', k === activeIdx));
    if (activeIdx >= 0) {
      const el = btns[activeIdx];
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
  };

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(activeIdx + 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(activeIdx - 1);
      return;
    }
    if (e.key === 'Enter') {
      if (activeIdx >= 0 && lastResults[activeIdx]) {
        e.preventDefault();
        openResult(lastResults[activeIdx]);
        close();
      }
    }
  };
  document.addEventListener('keydown', onKey, true);

  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  wrap.querySelectorAll('[data-search-close]').forEach((b) => b.addEventListener('click', close));

  resultsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.search-dialog__result');
    if (!btn) return;
    const idx = Number(btn.dataset.idx);
    const r = lastResults[idx];
    if (!r) return;
    openResult(r);
    close();
  });

  const render = (results, totalText, scanning) => {
    lastResults = results;
    if (!results.length) {
      resultsEl.innerHTML = '';
      statusEl.textContent = scanning ? 'Prohledávám soubory…' : 'Žádné výsledky.';
      activeIdx = -1;
      return;
    }
    const shown = results.slice(0, MAX_RESULTS);
    const extra = results.length > MAX_RESULTS ? ` (zobrazeno ${MAX_RESULTS})` : '';
    statusEl.textContent = scanning
      ? `${results.length}× zatím${extra} — prohledávám obsah…`
      : `${results.length}× ${totalText}${extra}.`;
    resultsEl.innerHTML = shown.map((r, i) => {
      const label = r.path ? `~/${r.path}${r.isDir ? '/' : ''}` : '~/';
      const tag = r.isDir ? 'složka' : (r.matchType === 'content' ? 'obsah' : 'název');
      const tagCls = r.isDir ? 'is-dir' : (r.matchType === 'content' ? 'is-content' : 'is-name');
      return `
        <button type="button" class="search-dialog__result${i === activeIdx ? ' is-active' : ''}" data-idx="${i}">
          <span class="search-dialog__result-tag ${tagCls}">${tag}</span>
          <span class="search-dialog__result-body">
            <span class="search-dialog__result-path">${highlight(label, r.query)}</span>
            ${r.snippet ? `<span class="search-dialog__result-snippet">${r.snippet}</span>` : ''}
          </span>
        </button>
      `;
    }).join('');
  };

  const run = async () => {
    const seq = ++runSeq;
    const q = input.value.trim().toLowerCase();
    activeIdx = -1;
    if (!q) {
      resultsEl.innerHTML = '';
      statusEl.textContent = 'Zadejte hledaný výraz.';
      lastResults = [];
      return;
    }
    if (!state.originalTree) {
      resultsEl.innerHTML = '';
      statusEl.textContent = 'Není načtený žádný zdroj.';
      lastResults = [];
      return;
    }

    const items = walkAll(state.originalTree);

    // 1) okamžitý průchod přes názvy + cache obsahu v paměti
    const results = [];
    const byPath = new Map();
    for (const item of items) {
      if (matchName(item, q)) {
        const r = { ...item, query: q, snippet: '', matchType: 'name' };
        results.push(r);
        byPath.set(item.path, r);
      }
    }
    // už načtený obsah — přidat snippety / nové matche bez fetchu
    const textItems = items.filter(isTextItem);
    for (const item of textItems) {
      const cached = item.node._originalRaw != null
        ? item.node._originalRaw
        : (item.node.raw != null ? item.node.raw : item.node.content);
      if (cached == null) continue;
      const lc = cached.toLowerCase();
      if (!lc.includes(q)) continue;
      const snippet = makeSnippet(cached, q);
      const exist = byPath.get(item.path);
      if (exist) {
        if (!exist.snippet) exist.snippet = snippet;
      } else {
        const r = { ...item, query: q, snippet, matchType: 'content' };
        results.push(r);
        byPath.set(item.path, r);
      }
    }

    if (seq !== runSeq) return;
    render(results, 'výsledků', textItems.some((it) =>
      it.node._originalRaw == null && it.node.raw == null && it.node.content == null
    ));

    // 2) lazy fetch zbylých text souborů (paralelně, batchovaně)
    const toScan = textItems.filter((it) => {
      const n = it.node;
      return n._originalRaw == null && n.raw == null && n.content == null;
    });
    if (!toScan.length) {
      render(results, 'výsledků', false);
      return;
    }

    let cursor = 0;
    const workers = new Array(Math.min(PARALLEL_FETCH, toScan.length)).fill(null).map(async () => {
      while (true) {
        if (seq !== runSeq) return;
        const my = cursor++;
        if (my >= toScan.length) return;
        const item = toScan[my];
        const text = await fetchNodeText(item.node, item.path);
        if (seq !== runSeq) return;
        if (text == null) continue;
        const lc = text.toLowerCase();
        if (!lc.includes(q)) continue;
        const snippet = makeSnippet(text, q);
        const exist = byPath.get(item.path);
        if (exist) {
          if (!exist.snippet) exist.snippet = snippet;
        } else {
          const r = { ...item, query: q, snippet, matchType: 'content' };
          results.push(r);
          byPath.set(item.path, r);
        }
        render(results, 'výsledků', true);
      }
    });
    await Promise.all(workers);
    if (seq !== runSeq) return;
    render(results, 'výsledků', false);
  };

  let deb = null;
  input.addEventListener('input', () => {
    clearTimeout(deb);
    deb = setTimeout(run, 120);
  });

  setTimeout(() => input.focus(), 0);
}
