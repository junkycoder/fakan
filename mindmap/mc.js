// Midnight Commander panel: dvoupanelový file manager nad VFS (shell-fs.js).
// Klávesy: Tab přepíná stranu, šipky/PgUp/PgDn/Home/End navigace,
// Enter = vstup do dir / view souboru, Backspace = ..,
// F3 view, F4 edit, F5 copy, F6 move, F7 mkdir, F8 delete, F9 menu, F10 quit,
// Ctrl+R reload, Ctrl+H toggle hidden, Ctrl+U swap panes.

import {
  resolvePath, stat, readdir, exists, isDir, normalizeCwd,
  mkdir, touchFile, removePath, copyFile, movePath, parentOf, basenameOf,
} from './shell-fs.js';

const F_KEYS = [
  ['1', 'Help'],
  ['2', 'Menu'],
  ['3', 'View'],
  ['4', 'Edit'],
  ['5', 'Copy'],
  ['6', 'RenMov'],
  ['7', 'Mkdir'],
  ['8', 'Delete'],
  ['9', 'PullDn'],
  ['10', 'Quit'],
];

function fmtPath(cwd) {
  const c = normalizeCwd(cwd);
  return c ? `~/${c}` : '~/';
}

function compareEntries(a, b) {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function listEntries(cwd, opts) {
  const entries = readdir(cwd) || [];
  const filtered = entries.filter((e) => opts.showHidden || !e.name.startsWith('.'));
  filtered.sort(compareEntries);
  // virtuální „..“ pro skok do rodiče (pokud nejsme v rootu)
  const list = [];
  if (normalizeCwd(cwd)) {
    list.push({ name: '..', type: 'dir', path: parentOf(cwd), virtual: true });
  }
  for (const e of filtered) list.push(e);
  return list;
}

function makePane(cwd) {
  return {
    cwd: normalizeCwd(cwd || ''),
    cursor: 0,
    top: 0,
    entries: [],
  };
}

export function mountMc(host, opts = {}) {
  const session = {
    panes: [makePane(opts.cwd), makePane(opts.cwd)],
    active: 0,
    showHidden: false,
    visibleRows: 20, // přepočítá se po insertu do DOM
  };

  const root = document.createElement('div');
  root.className = 'mc';
  root.tabIndex = 0;
  root.innerHTML = `
    <div class="mc__body">
      <div class="mc__pane mc__pane--left" data-mc-pane="0">
        <div class="mc__head" data-mc-head></div>
        <div class="mc__list" data-mc-list></div>
        <div class="mc__foot" data-mc-foot></div>
      </div>
      <div class="mc__pane mc__pane--right" data-mc-pane="1">
        <div class="mc__head" data-mc-head></div>
        <div class="mc__list" data-mc-list></div>
        <div class="mc__foot" data-mc-foot></div>
      </div>
    </div>
    <div class="mc__hint" data-mc-hint></div>
    <div class="mc__fbar" data-mc-fbar></div>
    <div class="mc__menu" data-mc-menu hidden></div>
  `;
  host.appendChild(root);

  const paneEls = [
    root.querySelector('[data-mc-pane="0"]'),
    root.querySelector('[data-mc-pane="1"]'),
  ];
  const fbarEl = root.querySelector('[data-mc-fbar]');
  const hintEl = root.querySelector('[data-mc-hint]');
  const menuEl = root.querySelector('[data-mc-menu]');

  function activePane() { return session.panes[session.active]; }
  function otherPane() { return session.panes[1 - session.active]; }

  function refreshPane(idx) {
    const pane = session.panes[idx];
    pane.entries = listEntries(pane.cwd, { showHidden: session.showHidden });
    if (pane.cursor >= pane.entries.length) pane.cursor = Math.max(0, pane.entries.length - 1);
  }

  function renderPane(idx) {
    const pane = session.panes[idx];
    const paneEl = paneEls[idx];
    const head = paneEl.querySelector('[data-mc-head]');
    const list = paneEl.querySelector('[data-mc-list]');
    const foot = paneEl.querySelector('[data-mc-foot]');

    paneEl.classList.toggle('is-active', idx === session.active);
    head.textContent = fmtPath(pane.cwd);

    // viewport scroll: drž kurzor v rozsahu [top, top+visibleRows-1]
    const rows = Math.max(1, session.visibleRows);
    if (pane.cursor < pane.top) pane.top = pane.cursor;
    if (pane.cursor >= pane.top + rows) pane.top = pane.cursor - rows + 1;
    const end = Math.min(pane.entries.length, pane.top + rows);

    const lines = [];
    for (let i = pane.top; i < end; i++) {
      const e = pane.entries[i];
      const cls = ['mc__entry'];
      if (e.type === 'dir') cls.push('mc__entry--dir');
      if (i === pane.cursor) cls.push('is-cursor');
      const label = e.type === 'dir' ? `${e.name}/` : e.name;
      lines.push(
        `<div class="${cls.join(' ')}" data-mc-row="${i}">${escapeHtml(label)}</div>`,
      );
    }
    if (!lines.length) lines.push('<div class="mc__entry mc__entry--empty">prázdno</div>');
    list.innerHTML = lines.join('');

    const cur = pane.entries[pane.cursor];
    if (cur) {
      const label = cur.type === 'dir' ? `${cur.name}/` : cur.name;
      foot.textContent = label;
    } else {
      foot.textContent = '';
    }
  }

  function renderAll() {
    renderPane(0);
    renderPane(1);
    renderFBar();
  }

  function renderFBar() {
    fbarEl.innerHTML = F_KEYS.map(([k, label]) =>
      `<button class="mc__fkey" type="button" data-mc-fkey="${k}"><span class="mc__fkey-num">${k}</span><span class="mc__fkey-label">${label}</span></button>`
    ).join('');
  }

  function setHint(text) {
    hintEl.textContent = text || '';
    if (text) {
      clearTimeout(hintEl._t);
      hintEl._t = setTimeout(() => { hintEl.textContent = ''; }, 3000);
    }
  }

  function focusInput() {
    try { root.focus({ preventScroll: true }); } catch { try { root.focus(); } catch {} }
  }

  // --- akce ----------------------------------------------------------------

  function enterEntry() {
    const pane = activePane();
    const e = pane.entries[pane.cursor];
    if (!e) return;
    if (e.type === 'dir') {
      const targetPath = e.virtual ? e.path : (pane.cwd ? `${pane.cwd}/${e.name}` : e.name);
      pane.cwd = normalizeCwd(targetPath);
      pane.cursor = 0;
      pane.top = 0;
      refreshPane(session.active);
      renderAll();
      return;
    }
    // soubor → view
    actionView();
  }

  function goParent() {
    const pane = activePane();
    if (!pane.cwd) return;
    const parent = parentOf(pane.cwd);
    const wasName = basenameOf(pane.cwd);
    pane.cwd = normalizeCwd(parent);
    refreshPane(session.active);
    // pokud najdeme původní složku v entries, postav na ni kurzor
    const idx = pane.entries.findIndex((x) => x.name === wasName && x.type === 'dir');
    pane.cursor = idx >= 0 ? idx : 0;
    pane.top = 0;
    renderAll();
  }

  function actionView() {
    const pane = activePane();
    const e = pane.entries[pane.cursor];
    if (!e || e.type !== 'file' || e.virtual) return;
    const fullPath = pane.cwd ? `${pane.cwd}/${e.name}` : e.name;
    const s = stat(fullPath);
    if (!s) { setHint(`view: ${e.name}: nic takového`); return; }
    if (opts.openPreview) opts.openPreview(s.node);
  }

  function actionEdit() {
    const pane = activePane();
    const e = pane.entries[pane.cursor];
    if (!e || e.type !== 'file' || e.virtual) return;
    const fullPath = pane.cwd ? `${pane.cwd}/${e.name}` : e.name;
    const s = stat(fullPath);
    if (!s) { setHint(`edit: ${e.name}: nic takového`); return; }
    if (opts.openMain) opts.openMain(s.node);
  }

  async function actionCopy() {
    const pane = activePane();
    const e = pane.entries[pane.cursor];
    if (!e || e.virtual) return;
    if (e.type === 'dir') { setHint('copy: adresáře zatím nepodporovány'); return; }
    const src = pane.cwd ? `${pane.cwd}/${e.name}` : e.name;
    const dstDir = otherPane().cwd;
    const proposed = dstDir ? `${dstDir}/${e.name}` : e.name;
    const dst = window.prompt(`Kopírovat ${e.name} do:`, proposed);
    if (dst == null || !dst.trim()) return;
    try {
      await copyFile(src, normalizeCwd(dst));
      refreshAll();
      renderAll();
      setHint(`zkopírováno do ${dst}`);
    } catch (err) {
      setHint(`copy: ${err.message || err}`);
    }
  }

  async function actionMove() {
    const pane = activePane();
    const e = pane.entries[pane.cursor];
    if (!e || e.virtual) return;
    if (e.type === 'dir') { setHint('mv: adresáře zatím nepodporovány'); return; }
    const src = pane.cwd ? `${pane.cwd}/${e.name}` : e.name;
    const dstDir = otherPane().cwd;
    const proposed = dstDir ? `${dstDir}/${e.name}` : e.name;
    const dst = window.prompt(`Přesunout ${e.name} do:`, proposed);
    if (dst == null || !dst.trim()) return;
    try {
      await movePath(src, normalizeCwd(dst));
      refreshAll();
      renderAll();
      setHint(`přesunuto do ${dst}`);
    } catch (err) {
      setHint(`mv: ${err.message || err}`);
    }
  }

  function actionMkdir() {
    const pane = activePane();
    const name = window.prompt('Nová složka:', '');
    if (name == null || !name.trim()) return;
    if (name.includes('/')) { setHint('mkdir: použijte jednoduché jméno'); return; }
    const target = pane.cwd ? `${pane.cwd}/${name}` : name;
    try {
      mkdir(target);
      refreshAll();
      // postav kurzor na nově vytvořenou složku
      const p = session.panes[session.active];
      const idx = p.entries.findIndex((x) => x.name === name && x.type === 'dir');
      if (idx >= 0) p.cursor = idx;
      renderAll();
    } catch (err) {
      setHint(`mkdir: ${err.message || err}`);
    }
  }

  function actionDelete() {
    const pane = activePane();
    const e = pane.entries[pane.cursor];
    if (!e || e.virtual) return;
    const fullPath = pane.cwd ? `${pane.cwd}/${e.name}` : e.name;
    const label = e.type === 'dir' ? `složku ${e.name}/ (rekurzivně)` : `soubor ${e.name}`;
    if (!window.confirm(`Smazat ${label}?`)) return;
    try {
      removePath(fullPath, { recursive: e.type === 'dir' });
      refreshAll();
      renderAll();
    } catch (err) {
      setHint(`rm: ${err.message || err}`);
    }
  }

  function actionMenu() {
    if (!menuEl.hidden) { menuEl.hidden = true; return; }
    menuEl.innerHTML = `
      <div class="mc__menu-title">Menu</div>
      <button type="button" data-mc-menu-act="toggleHidden">${session.showHidden ? '✓ ' : '  '}Zobrazit skryté soubory (Ctrl+H)</button>
      <button type="button" data-mc-menu-act="swap">Prohodit panely (Ctrl+U)</button>
      <button type="button" data-mc-menu-act="reload">Načíst znovu (Ctrl+R)</button>
      <button type="button" data-mc-menu-act="quit">Zavřít (F10)</button>
    `;
    menuEl.hidden = false;
  }

  function refreshAll() {
    refreshPane(0);
    refreshPane(1);
  }

  function toggleHidden() {
    session.showHidden = !session.showHidden;
    refreshAll();
    renderAll();
    setHint(session.showHidden ? 'skryté: zobrazit' : 'skryté: skrýt');
  }

  function swapPanes() {
    const [a, b] = session.panes;
    session.panes = [b, a];
    renderAll();
  }

  function reload() {
    refreshAll();
    renderAll();
  }

  function quit() {
    if (opts.onClose) opts.onClose();
  }

  // --- klávesnice ----------------------------------------------------------

  function moveCursor(delta) {
    const pane = activePane();
    if (!pane.entries.length) return;
    pane.cursor = Math.max(0, Math.min(pane.entries.length - 1, pane.cursor + delta));
    renderPane(session.active);
  }

  function jumpCursor(where) {
    const pane = activePane();
    if (!pane.entries.length) return;
    if (where === 'home') pane.cursor = 0;
    else if (where === 'end') pane.cursor = pane.entries.length - 1;
    renderPane(session.active);
  }

  function onKey(e) {
    // F-keys
    if (e.key === 'F1') { e.preventDefault(); setHint('F3 view · F4 edit · F5 copy · F6 mv · F7 mkdir · F8 del · F9 menu · F10 quit'); return; }
    if (e.key === 'F2' || e.key === 'F9') { e.preventDefault(); actionMenu(); return; }
    if (e.key === 'F3') { e.preventDefault(); actionView(); return; }
    if (e.key === 'F4') { e.preventDefault(); actionEdit(); return; }
    if (e.key === 'F5') { e.preventDefault(); actionCopy(); return; }
    if (e.key === 'F6') { e.preventDefault(); actionMove(); return; }
    if (e.key === 'F7') { e.preventDefault(); actionMkdir(); return; }
    if (e.key === 'F8' || e.key === 'Delete') { e.preventDefault(); actionDelete(); return; }
    if (e.key === 'F10' || e.key === 'Escape') { e.preventDefault(); quit(); return; }

    if (e.key === 'Tab') {
      e.preventDefault();
      session.active = 1 - session.active;
      renderAll();
      return;
    }
    if (e.key === 'ArrowUp'   || e.key === 'k') { e.preventDefault(); moveCursor(-1); return; }
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); moveCursor(+1); return; }
    if (e.key === 'h') { e.preventDefault(); goParent(); return; }
    if (e.key === 'l') { e.preventDefault(); enterEntry(); return; }
    if (e.key === 'PageUp')    { e.preventDefault(); moveCursor(-session.visibleRows + 1); return; }
    if (e.key === 'PageDown')  { e.preventDefault(); moveCursor(+session.visibleRows - 1); return; }
    if (e.key === 'Home')      { e.preventDefault(); jumpCursor('home'); return; }
    if (e.key === 'End')       { e.preventDefault(); jumpCursor('end'); return; }
    if (e.key === 'Enter')     { e.preventDefault(); enterEntry(); return; }
    if (e.key === 'Backspace') { e.preventDefault(); goParent(); return; }

    if (e.ctrlKey && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); toggleHidden(); return; }
    if (e.ctrlKey && (e.key === 'u' || e.key === 'U')) { e.preventDefault(); swapPanes(); return; }
    if (e.ctrlKey && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); reload(); return; }
  }

  root.addEventListener('keydown', onKey);

  // klik na položku: aktivuj stranu + nastav kurzor; double-click = enter
  root.addEventListener('click', (e) => {
    const fkeyBtn = e.target.closest('[data-mc-fkey]');
    if (fkeyBtn) {
      const k = fkeyBtn.dataset.mcFkey;
      const map = { '1': 'F1', '2': 'F9', '3': 'F3', '4': 'F4', '5': 'F5', '6': 'F6', '7': 'F7', '8': 'F8', '9': 'F9', '10': 'F10' };
      const ev = new KeyboardEvent('keydown', { key: map[k] });
      onKey(ev);
      focusInput();
      return;
    }
    const menuBtn = e.target.closest('[data-mc-menu-act]');
    if (menuBtn) {
      const act = menuBtn.dataset.mcMenuAct;
      menuEl.hidden = true;
      if (act === 'toggleHidden') toggleHidden();
      else if (act === 'swap') swapPanes();
      else if (act === 'reload') reload();
      else if (act === 'quit') quit();
      focusInput();
      return;
    }
    const paneEl = e.target.closest('[data-mc-pane]');
    if (paneEl) {
      const idx = Number(paneEl.dataset.mcPane);
      if (idx !== session.active) {
        session.active = idx;
      }
      const row = e.target.closest('[data-mc-row]');
      if (row) {
        const i = Number(row.dataset.mcRow);
        const pane = session.panes[session.active];
        if (Number.isFinite(i) && i >= 0 && i < pane.entries.length) pane.cursor = i;
      }
      renderAll();
      focusInput();
    }
  });
  root.addEventListener('dblclick', (e) => {
    if (e.target.closest('[data-mc-row]')) {
      enterEntry();
    }
  });

  // přepočet visibleRows při resize panelu
  const ro = new ResizeObserver(() => {
    const listEl = paneEls[0].querySelector('[data-mc-list]');
    const h = listEl ? listEl.clientHeight : 0;
    // řádek odhadem 18 px (line-height z styles.css .mc__entry)
    const rows = Math.max(5, Math.floor(h / 18));
    if (rows !== session.visibleRows) {
      session.visibleRows = rows;
      renderAll();
    }
  });
  ro.observe(root);

  refreshAll();
  renderAll();
  requestAnimationFrame(focusInput);

  return {
    focus: focusInput,
    destroy: () => {
      try { ro.disconnect(); } catch {}
      try { root.removeEventListener('keydown', onKey); } catch {}
      try { root.remove(); } catch {}
    },
    root,
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
