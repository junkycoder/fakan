// Panely (okna): create / open / close / drag / resize / edit / media / markdown.
// + spodní navigace (renderNav).

import { mountEditor } from './editor.js';
import {
  state,
  PANEL_CASCADE,
  escapeHtml, mediaKind,
  parseFrontmatter,
  applyEditToNode, saveEditOverride,
} from './state.js';
import {
  recenter, removeFromHistory,
  refreshOpenLabels, renderDirTree,
  addTreeNode, removeTreeNode, rebuildMindmap,
} from './mindmap.js';
import { syncFromState, findNodeByPath } from './url.js';

// --- minimal markdown renderer ----------------------------------------------
// Podmnožina: nadpisy, odstavce, **bold**, *italic*, `code`, ``` block ```,
// `- ` seznamy, [text](url) odkazy, horizontální čára `---`.

function renderMarkdown(md) {
  let s = String(md || '');

  // 1) vytáhneme code-blocky (``` ... ```) jako placeholdery, ať nepodléhají inline transformacím
  const blocks = [];
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre class="md-code"><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return ` B${blocks.length - 1} `;
  });

  // 2) escape zbytku
  s = escapeHtml(s);

  // 3) inline code (`...`)
  s = s.replace(/`([^`\n]+)`/g, '<code class="md-inline">$1</code>');

  // 4) odkazy [text](url)
  //    - externí (http/mailto/tel) → otevřít v nové záložce
  //    - interní (relativní / root-absolutní bez schématu) → značka pro panel-routing
  //    - #anchor → necháme být
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    if (/^(https?:|mailto:|tel:)/i.test(url)) {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    }
    if (url.startsWith('#')) {
      return `<a href="${url}">${text}</a>`;
    }
    const safe = url.replace(/"/g, '&quot;');
    return `<a href="${safe}" data-fakan-link="${safe}">${text}</a>`;
  });

  // 5) bold + italic
  s = s.replace(/\*\*([^\*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<![\*\w])\*([^\*\n]+)\*(?!\w)/g, '<em>$1</em>');

  // 6) nadpisy
  s = s.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
  s = s.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
  s = s.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // 7) horizontální čára
  s = s.replace(/^---+$/gm, '<hr>');

  // 8) seznamy `- item` (po sobě jdoucí řádky → <ul>)
  s = s.replace(/(?:^- .+\n?)+/gm, (m) => {
    const items = m.trim().split('\n')
      .map((l) => l.replace(/^- /, '').trim())
      .map((t) => `<li>${t}</li>`).join('');
    return `<ul>${items}</ul>`;
  });

  // 9) odstavce: split na prázdné řádky, vše co není už block-element zabalíme do <p>
  const isBlock = /^<(h\d|ul|ol|pre|hr|p|blockquote)/i;
  const paras = s.split(/\n{2,}/).map((p) => {
    const t = p.trim();
    if (!t) return '';
    if (t.startsWith(' B')) return t;
    if (isBlock.test(t)) return t;
    return `<p>${t.replace(/\n/g, '<br>')}</p>`;
  }).filter(Boolean).join('\n');

  // 10) vrátíme code-blocky zpět
  return paras.replace(/ B(\d+) /g, (_, i) => blocks[Number(i)]);
}

// --- defaultní mode pro panel ------------------------------------------------
// MD / HTML / dir-s-index.html se otevírají rovnou v rendered módu.
// Ostatní spustitelné soubory (např. budoucí .sh / .js v .bin/) otevíráme jako
// source — uživatel přepne playem ručně.
function defaultPanelMode(node) {
  if (!node) return 'source';
  if (node.kind === 'web') return 'rendered';
  if (node.type === 'dir' && dirIndexHtml(node)) return 'rendered';
  // .md a .html otevíráme v rendered módu i bez načteného obsahu —
  // panel ho lazy fetchne přes node.path.
  if (node.kind === 'md') return 'rendered';
  const fn = (node.filename || node.name || '').toLowerCase();
  if ((fn.endsWith('.html') || fn.endsWith('.htm')) && (node.raw || node.path)) return 'rendered';
  if (mediaKind(node)) return 'rendered';
  return 'source';
}

// --- routing odkazů z obsahu (MD + iframe HTML) -----------------------------

// Injekt do <head> srcdoc iframe:
//   1) style — srcdoc nemá <base>, takže relativní href="styles.css" se resolvne
//      vůči parentu a načte fakan-app CSS s `body { overflow: hidden }`.
//      Tímhle override-em zaručíme, že obsah panelu jde scrollovat.
//   2) script — odchytí klik na <a> a postMessage parentovi pro panel-routing.
const IFRAME_HEAD_INJECT = `<style>html,body{height:auto !important;min-height:100% !important;overflow:auto !important}</style><script>
(function(){
  document.addEventListener('click', function(e){
    var a = e.target.closest && e.target.closest('a[href]');
    if(!a) return;
    var href = a.getAttribute('href');
    if(!href || href.charAt(0) === '#') return;
    if(/^(https?:|mailto:|tel:|javascript:|data:)/i.test(href)) return; // ať otevře browser
    e.preventDefault();
    parent.postMessage({
      type: 'fakan-link',
      href: href,
      shift: !!e.shiftKey,
      meta: !!e.metaKey,
      ctrl: !!e.ctrlKey,
    }, '*');
  }, true);
})();
</script>`;

function injectIframeLinkScript(html) {
  const s = String(html || '');
  if (/<\/head>/i.test(s)) return s.replace(/<\/head>/i, IFRAME_HEAD_INJECT + '</head>');
  if (/<head[^>]*>/i.test(s)) return s.replace(/<head[^>]*>/i, (m) => m + IFRAME_HEAD_INJECT);
  if (/<body[^>]*>/i.test(s)) return s.replace(/<body[^>]*>/i, (m) => m + IFRAME_HEAD_INJECT);
  if (/<html[^>]*>/i.test(s)) return s.replace(/<html[^>]*>/i, (m) => m + IFRAME_HEAD_INJECT);
  return IFRAME_HEAD_INJECT + s;
}

// Resolve relativního / absolutního hrefu vůči path zdrojového uzlu.
// Vrací cestu vhodnou pro state.byPath (bez leading/trailing slash).
function resolveLinkPath(sourcePath, href) {
  let h = String(href || '').replace(/[?#].*$/, '');
  if (!h) return '';
  if (h.startsWith('/')) {
    h = h.replace(/^\/+/, '');
  } else {
    const dir = String(sourcePath || '').split('/').slice(0, -1).filter(Boolean);
    const parts = dir.slice();
    for (const seg of h.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    h = parts.join('/');
  }
  return h.replace(/\/+$/, '');
}

function openByHref(href, sourcePath, mods) {
  if (!href) return;
  if (href.startsWith('#')) return;
  if (/^(https?:|mailto:|tel:|javascript:|data:)/i.test(href)) {
    window.open(href, '_blank', 'noopener,noreferrer');
    return;
  }
  const path = resolveLinkPath(sourcePath || '', href);
  let node = state.byPath.get(path);
  if (!node && path) {
    // dir bez koncového slashe, anebo link na složku → zkus rootový index
    node = state.byPath.get(path + '/index.html')
        || state.byPath.get(path + '/index.md')
        || state.byPath.get(path + '/README.md');
  }
  if (!node && !path) node = state.byPath.get('');
  // path mimo aktuální subtree → hledej v celém stromu (recenter na složku)
  if (!node && path && state.originalTree) {
    const raw = findNodeByPath(state.originalTree, path);
    if (raw && (raw.type === 'dir' || raw.type === 'root')) {
      recenter(path);
      return;
    }
  }
  if (!node) return;
  // link na složku / root → recentruj mapu místo otevírání prázdného panelu
  if (node.type === 'root' || node.type === 'dir') {
    recenter(node.path || '');
    return;
  }
  if (mods && mods.shift) openMainOnly(node);
  else if (mods && (mods.meta || mods.ctrl)) openAsFollower(node);
  else openMain(node);
}

let _msgListenerInstalled = false;
function installIframeMessageListener() {
  if (_msgListenerInstalled) return;
  _msgListenerInstalled = true;
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.type !== 'fakan-link') return;
    // najdi panel, jehož iframe poslal zprávu
    const panels = allPanels();
    const panel = panels.find((p) => {
      const ifr = p.element.querySelector('iframe.iframe-preview');
      return ifr && ifr.contentWindow === e.source;
    });
    if (!panel) return;
    openByHref(d.href, panel.node.path || '', {
      shift: !!d.shift, meta: !!d.meta, ctrl: !!d.ctrl,
    });
  });
}

// --- panely (windows) -------------------------------------------------------

function allPanels() {
  const out = [];
  if (state.mainPanel) out.push(state.mainPanel);
  for (const p of state.previewPanels.values()) out.push(p);
  return out;
}

export function getAllPanels() { return allPanels(); }

export function setActive(panel) {
  if (state.activePanel === panel) return;
  if (state.activePanel) state.activePanel.element.classList.remove('is-active');
  state.activePanel = panel;
  if (panel) panel.element.classList.add('is-active');
  if (state.panelNavListener) state.panelNavListener();
}

function pathLabel(node) {
  const p = node.path || '';
  if (!p) return '~/';
  // dir → trailing slash; root je '~/'
  return '~/' + (node.type === 'dir' ? `${p}/` : p);
}

function sourceBody(node) {
  if (node.type === 'root') {
    return '<p class="panel__note">Mindmapa fakan.cz. Klikněte uzel pro otevření.</p>';
  }
  if (node.type === 'dir') {
    if (!node.hasChildren) return '<p class="panel__note empty">Zatím prázdné.</p>';
    return renderDirTree(node);
  }
  if (node.kind === 'web') {
    const url = node.url || '';
    const fetched = node.fetched_at ? ` · staženo ${escapeHtml(node.fetched_at)}` : '';
    return `<p class="panel__note">Snapshot externí stránky. <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">otevřít originál ↗</a>${fetched}</p>`;
  }
  // soubor: vim editor (mount po vložení do DOM).
  return `<div class="vim-mount" data-vim-mount></div>`;
}

function renderedBody(node) {
  if (node.kind === 'web') {
    // single-file snapshot na disku — browser ho fetchne přes path.
    // Sandbox bez allow-same-origin = snapshot nevidí na fakan.cz state (IndexedDB, localStorage).
    const src = encodeURI(node.path || '');
    const titleAttr = escapeHtml(node.title || node.url || node.name);
    return `<iframe class="iframe-preview" src="${src}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" title="${titleAttr}"></iframe>`;
  }
  const mk = mediaKind(node);
  if (mk) {
    // URL musíme vyřešit asynchronně (FSA → blob URL). Vrátíme placeholder
    // s data-media-mount; panel po insertu zavolá mountMediaIfNeeded.
    return `<div class="media-mount" data-media-mount data-media-kind="${mk}"></div>`;
  }
  if (node.kind === 'md' && node.content) {
    return `<div class="md">${renderMarkdown(node.content)}</div>`;
  }
  if (node.kind === 'md' && node.path) {
    // Obsah ještě nedorazil — panel ho fetchne a re-renderuje.
    return `<p class="panel__note empty" data-panel-loading>Načítám…</p>`;
  }
  const fn = (node.filename || node.name || '').toLowerCase();
  if (fn.endsWith('.html') || fn.endsWith('.htm')) {
    // Pokud máme `raw` (lokální složka / GitHub fetch), renderujeme přes srcdoc.
    // Jinak pro statický deploy iframe stáhne přímo přes path.
    if (node.raw) {
      const wrapped = injectIframeLinkScript(node.raw);
      const srcdoc = wrapped.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      return `<iframe class="iframe-preview" srcdoc="${srcdoc}" sandbox="allow-scripts" title="${escapeHtml(node.filename || node.name)}"></iframe>`;
    }
    if (node.path) {
      const src = encodeURI(node.path);
      return `<iframe class="iframe-preview" src="${src}" sandbox="allow-scripts" title="${escapeHtml(node.filename || node.name)}"></iframe>`;
    }
  }
  // adresář s index.html: vyrenderuj jeho index.html
  const idx = dirIndexHtml(node);
  if (idx) {
    if (idx.raw) {
      const wrapped = injectIframeLinkScript(idx.raw);
      const srcdoc = wrapped.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      return `<iframe class="iframe-preview" srcdoc="${srcdoc}" sandbox="allow-scripts" title="${escapeHtml(node.name + '/index.html')}"></iframe>`;
    }
    if (idx.path) {
      const src = encodeURI(idx.path);
      return `<iframe class="iframe-preview" src="${src}" sandbox="allow-scripts" title="${escapeHtml(node.name + '/index.html')}"></iframe>`;
    }
  }
  if (node.kind === 'md') {
    return `<p class="panel__note empty">Žádný obsah k vyrendrování.</p>`;
  }
  return sourceBody(node);
}

function dirIndexHtml(node) {
  if (!node || node.type !== 'dir') return null;
  const idx = state.byPath.get((node.path || '') + '/index.html');
  if (!idx) return null;
  // raw může chybět (statický deploy bez inline contentu) — v takovém případě
  // se použije idx.path přímo v iframe src.
  return idx;
}

function canBuild(node) {
  if (node.kind === 'web') return true;
  // MD a HTML jsou vždy buildable — pokud chybí obsah, panel ho lazy fetchne.
  if (node.kind === 'md' && (node.content || node.path)) return true;
  const fn = (node.filename || node.name || '').toLowerCase();
  if ((fn.endsWith('.html') || fn.endsWith('.htm')) && (node.raw || node.path)) return true;
  if (dirIndexHtml(node)) return true;
  // media (audio/video/image/pdf) — má kde stáhnout (path / handle / blob)
  if (mediaKind(node) && (node.path || node._handle || node.raw != null || node.content != null)) return true;
  return false;
}

// --- node → resolvable URL (pro media + download) ---------------------------

async function nodeFileBlob(node) {
  if (!node) return null;
  if (node._handle && typeof node._handle.getFile === 'function') {
    try { return await node._handle.getFile(); } catch {}
  }
  if (node._file instanceof Blob) return node._file;
  const text = node.raw != null ? node.raw : (node.content != null ? node.content : null);
  if (text != null) {
    return new Blob([text], { type: 'text/plain;charset=utf-8' });
  }
  // statický deploy — path je fetchovatelný
  if (node.path && !state.rootHandle && !state.uploadedSnapshot && !state.githubSpec) {
    try {
      const res = await fetch(encodeURI(node.path), { cache: 'force-cache' });
      if (res.ok) return await res.blob();
    } catch {}
  }
  return null;
}

// Synchronní hint — vrací URL pokud je rovnou fetchovatelná (static deploy /
// web snapshot). Jinak null → volající musí dotáhnout blob.
function nodeDirectUrl(node) {
  if (!node || !node.path) return null;
  if (node.kind === 'web') return encodeURI(node.path);
  if (state.rootHandle || state.uploadedSnapshot || state.githubSpec) return null;
  return encodeURI(node.path);
}

// --- lazy fetch obsahu file uzlů --------------------------------------------
// tree.json drží jen strukturu + metadata (title, slug). Tělo souborů se
// fetchne přes node.path až při otevření panelu. Cache po prvním fetchi.

const _contentFetches = new Map(); // path → Promise

function nodeNeedsLazyContent(node) {
  if (!node || node.type !== 'file') return false;
  if (node.kind === 'web') return false; // web uzly renderuje iframe přes path
  if (mediaKind(node)) return false;     // media řeší mountMediaIfNeeded
  if (node._originalRaw != null) return false;
  // máme content v paměti (FSA scan / LS override) — fetch už není potřeba
  if (node.raw != null || node.content != null) return false;
  // potřebujeme zdroj, ze kterého content dotáhneme: FSA handle nebo HTTP path
  return !!(node._handle || node.path);
}

async function ensureNodeContent(node) {
  if (!nodeNeedsLazyContent(node)) return;
  const key = node.path || (node._handle && node._handle.name) || node.name;
  if (_contentFetches.has(key)) return _contentFetches.get(key);
  const p = (async () => {
    try {
      let text;
      if (node._handle && typeof node._handle.getFile === 'function') {
        const file = await node._handle.getFile();
        text = await file.text();
      } else {
        const res = await fetch(encodeURI(node.path), { cache: 'force-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = await res.text();
      }
      node._originalRaw = text;
      // pokud LS override už nastavil content/raw, nepřepisujeme ho fetched verzí
      const hasOverride = node.raw != null || node.content != null;
      if (!hasOverride) {
        if (node.kind === 'md') {
          const [fm, body] = parseFrontmatter(text);
          if (!node.title) node.title = fm.title || '';
          if (!node.slug) node.slug = fm.slug || '';
          node.content = body;
          node.raw = text;
        } else {
          node.content = text;
          node.raw = text;
        }
      }
    } catch (e) {
      console.warn('lazy fetch failed', node.path || node.name, e);
      _contentFetches.delete(key); // dovol retry při dalším otevření
      throw e;
    }
  })();
  _contentFetches.set(key, p);
  return p;
}

function rerenderPanelBody(panel) {
  if (!panel || !panel.element || !panel.element.isConnected) return;
  const bodyEl = panel.element.querySelector('[data-panel-body]');
  if (!bodyEl) return;
  destroyEditor(panel);
  revokePanelUrls(panel);
  bodyEl.innerHTML = panel.mode === 'source' ? sourceBody(panel.node) : renderedBody(panel.node);
  mountEditorIfNeeded(panel, bodyEl);
  mountMediaIfNeeded(panel, bodyEl);
}

function revokePanelUrls(panel) {
  if (!panel || !panel.objectUrls) return;
  for (const u of panel.objectUrls) {
    try { URL.revokeObjectURL(u); } catch {}
  }
  panel.objectUrls.length = 0;
}

// --- media mount (audio / video / image / pdf) ------------------------------

async function mountMediaIfNeeded(panel, bodyEl) {
  const mount = bodyEl.querySelector('[data-media-mount]');
  if (!mount) return;
  const kind = mount.dataset.mediaKind;
  const node = panel.node;

  // 1) Pokud máme přímou URL (statický deploy / web kind), použij ji.
  let url = nodeDirectUrl(node);
  // 2) Jinak vyrobit blob URL z handle / file / raw / fetch.
  if (!url) {
    try {
      const blob = await nodeFileBlob(node);
      if (blob) {
        url = URL.createObjectURL(blob);
        panel.objectUrls.push(url);
      }
    } catch (e) { console.warn('media blob failed', e); }
  }
  // pokud mezitím panel zavřel nebo se re-renderoval, mount už není v DOM
  if (!mount.isConnected) return;
  if (!url) {
    mount.innerHTML = `<p class="panel__note empty">Soubor nelze přehrát: chybí zdrojová data.</p>`;
    return;
  }
  const titleAttr = escapeHtml(node.filename || node.name || '');
  if (kind === 'video') {
    mount.innerHTML = `<video class="media-el media-el--video" src="${url}" controls preload="metadata" playsinline title="${titleAttr}"></video>`;
  } else if (kind === 'audio') {
    mount.innerHTML = `<audio class="media-el media-el--audio" src="${url}" controls preload="metadata" title="${titleAttr}"></audio>`;
  } else if (kind === 'image') {
    mount.innerHTML = `<img class="media-el media-el--image" src="${url}" alt="${titleAttr}" title="${titleAttr}">`;
  } else if (kind === 'pdf') {
    // embed funguje líp na mobilu i desktopu než <object>
    mount.innerHTML = `<embed class="media-el media-el--pdf" src="${url}" type="application/pdf" title="${titleAttr}">`;
  }
}

export function bringToFront(el) {
  state.panelZ++;
  el.style.zIndex = String(state.panelZ);
}

function createPanel(node, variant) {
  const path = node.path || '/';
  const el = document.createElement('section');
  el.className = `panel panel--${variant}`;
  el.dataset.path = path;

  const buildable = canBuild(node);
  // MD / HTML / dir-s-index.html otevíráme rovnou v rendered módu;
  // ostatní (text bez build cesty) v source. Play tlačítko jen mezi tím přepíná.
  const initialMode = buildable ? defaultPanelMode(node) : 'source';
  const playLabel = initialMode === 'source' ? 'play' : 'src';
  const playTitle = initialMode === 'source' ? 'Sestavit / náhled' : 'Zpět na zdroj';
  const webRef = node.kind === 'web' && node.url
    ? `<a class="panel__webref" href="${escapeHtml(node.url)}" target="_blank" rel="noopener noreferrer" title="Otevřít originál ${escapeHtml(node.url)}">↗</a>`
    : '';
  el.innerHTML = `
    <header class="panel__head" data-panel-head>
      <span class="panel__path">${escapeHtml(pathLabel(node))}</span>
      ${webRef}
      <div class="panel__actions">
        ${buildable ? `<button class="panel__btn panel__btn--play${initialMode === 'rendered' ? ' is-active' : ''}" type="button" data-panel-play title="${playTitle}" aria-label="Sestavit">${playLabel}</button>` : ''}
        <button class="panel__btn panel__btn--max" type="button" data-panel-max title="Maximalizovat" aria-label="Maximalizovat">▢</button>
        <button class="panel__btn panel__btn--close" type="button" data-panel-close title="Zavřít" aria-label="Zavřít">×</button>
      </div>
    </header>
    <div class="panel__body" data-panel-body>${initialMode === 'source' ? sourceBody(node) : renderedBody(node)}</div>
  `;

  const panel = {
    element: el,
    node,
    path,
    variant,
    mode: initialMode,
    isMax: false,
    savedStyles: null,
    objectUrls: [],   // blob: URL pro media/download — revokuj v closePanel
  };
  return panel;
}

function positionPanel(panel) {
  const el = panel.element;
  if (state.lastPanelPos) {
    el.style.left = `${state.lastPanelPos.left + PANEL_CASCADE}px`;
    el.style.top = `${state.lastPanelPos.top + PANEL_CASCADE}px`;
  } else if (panel.variant === 'main') {
    el.style.left = '16px';
    el.style.top = `calc(16px + var(--safe-t))`;
  } else {
    el.style.left = '24px';
    el.style.top = `calc(24px + var(--safe-t))`;
  }
  // zapamatuj si pozici jako baseline pro další panel (po layoutu, ať máme px)
  requestAnimationFrame(() => rememberPanelPos(el));
}

function rememberPanelPos(el) {
  const rect = el.getBoundingClientRect();
  state.lastPanelPos = { left: rect.left, top: rect.top };
}

// --- editor mount / persist -------------------------------------------------

function mountEditorIfNeeded(panel, bodyEl) {
  const host = bodyEl.querySelector('[data-vim-mount]');
  if (!host) return;
  const node = panel.node;
  // pokud čekáme na lazy fetch, editor mount preskočíme — rerenderPanelBody ho
  // pozdě dohraje, jakmile obsah dorazí.
  if (nodeNeedsLazyContent(node)) return;
  const filename = node.filename || node.name || '';
  const initialText = node.raw != null ? node.raw : (node.content || '');
  let debounce = null;
  const handle = mountEditor(host, {
    text: initialText,
    filename,
    onChange: (text) => {
      applyEditToNode(node, text);
      clearTimeout(debounce);
      debounce = setTimeout(() => saveEditOverride(node, text), 400);
    },
    onSave: (text) => {
      applyEditToNode(node, text);
      saveEditOverride(node, text);
    },
    onClose: () => closePanel(panel),
  });
  panel.editor = handle;
  // dej editoru focus, aby vim klávesy fungovaly hned —
  // u followera (Space) ale ne, aby šipky zůstaly v mindmapě
  if (panel.autofocusEditor !== false) {
    requestAnimationFrame(() => handle.focus());
  }
}

function destroyEditor(panel) {
  if (panel.editor) {
    try { panel.editor.destroy(); } catch {}
    panel.editor = null;
  }
}

function setupPanelInteractions(panel) {
  const el = panel.element;
  const head = el.querySelector('[data-panel-head]');
  const playBtn = el.querySelector('[data-panel-play]');
  const maxBtn = el.querySelector('[data-panel-max]');
  const closeBtn = el.querySelector('[data-panel-close]');
  const bodyEl = el.querySelector('[data-panel-body]');

  mountEditorIfNeeded(panel, bodyEl);
  mountMediaIfNeeded(panel, bodyEl);
  installIframeMessageListener();
  closeBtn.addEventListener('click', () => closePanel(panel));

  // odkazy v MD obsahu — interní routing do panelu
  bodyEl.addEventListener('click', (e) => {
    const link = e.target.closest('[data-fakan-link]');
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();
    openByHref(link.dataset.fakanLink, panel.node.path || '', {
      shift: e.shiftKey, meta: e.metaKey, ctrl: e.ctrlKey,
    });
  });

  // lazy fetch obsahu (statický deploy) — po doručení re-renderuje body
  if (nodeNeedsLazyContent(panel.node)) {
    ensureNodeContent(panel.node)
      .then(() => { rerenderPanelBody(panel); })
      .catch(() => {});
  }

  // + / − tlačítka v ASCII stromu (přidat / smazat soubor / složku)
  bodyEl.addEventListener('click', (e) => {
    const addBtn = e.target.closest('.src-tree .n-add');
    if (addBtn) {
      e.preventDefault();
      e.stopPropagation();
      const raw = addBtn.dataset.addParent;
      const parentPath = raw === '/' ? '' : raw;
      const input = window.prompt(
        'Nový soubor / složka (koncové „/" = složka, např. „blog/" nebo „pisen.md"):',
        ''
      );
      if (input == null) return;
      const newPath = addTreeNode(parentPath, input);
      if (!newPath) return;
      rebuildMindmap(panel.node.path || '');
      const refreshed = state.byPath.get(panel.path === '/' ? '' : panel.path);
      if (refreshed) panel.node = refreshed;
      rerenderPanelBody(panel);
      const created = state.byPath.get(newPath);
      if (created && created.type === 'file') openMain(created);
      return;
    }
    const rmBtn = e.target.closest('.src-tree .n-rm');
    if (rmBtn) {
      e.preventDefault();
      e.stopPropagation();
      const raw = rmBtn.dataset.rmPath;
      const path = raw === '/' ? '' : raw;
      if (!path) return;
      const node = state.byPath.get(path);
      const isDir = node && (node.type === 'dir' || node.type === 'root');
      const hasChildren = isDir && (state.childrenByPath.get(path) || []).length > 0;
      const label = node ? node.name : path;
      const msg = hasChildren
        ? `Smazat složku „${label}/" včetně obsahu?`
        : `Smazat „${label}"?`;
      if (!window.confirm(msg)) return;
      // zavři případné otevřené panely k tomuto uzlu (a jeho potomkům)
      for (const p of getAllPanels()) {
        const pp = p.path === '/' ? '' : p.path;
        if (pp === path || pp.startsWith(path + '/')) closePanel(p);
      }
      if (!removeTreeNode(path)) return;
      rebuildMindmap(panel.node.path || '');
      const refreshed = state.byPath.get(panel.path === '/' ? '' : panel.path);
      if (refreshed) { panel.node = refreshed; rerenderPanelBody(panel); }
      return;
    }
  });

  // klikatelné uzly v ASCII stromu (jen u dir-panelu, ale handler je univerzální)
  let pendingTreeSingle = null;
  const handleTreeNode = (e, mode) => {
    // klik na + / − má prioritu (řeší blok výš), tady ho přeskoč
    if (e.target.closest('.src-tree .n-add, .src-tree .n-rm')) return;
    const span = e.target.closest('.src-tree .n');
    if (!span) return;
    const raw = span.dataset.path;
    if (raw == null) return;
    const path = raw === '/' ? '' : raw;
    const node = state.byPath.get(path);
    if (!node) return;
    e.preventDefault();
    e.stopPropagation();
    const isDir = node.type === 'dir' || node.type === 'root';
    // dblclick: složka = recenter (otevři), soubor = openMain (nové okno)
    if (mode === 'new') {
      if (pendingTreeSingle) { clearTimeout(pendingTreeSingle); pendingTreeSingle = null; }
      if (isDir) recenter(node.path || '');
      else openMain(node);
      return;
    }
    if (e.shiftKey) { openMainOnly(node); return; }
    if (e.metaKey || e.ctrlKey) { openAsFollower(node); return; }
    // plain single click (soubor i složka) = follower preview, s 220ms timeoutem
    if (pendingTreeSingle) clearTimeout(pendingTreeSingle);
    pendingTreeSingle = setTimeout(() => { pendingTreeSingle = null; openAsFollower(node); }, 220);
  };
  bodyEl.addEventListener('click', (e) => handleTreeNode(e, 'main'));
  bodyEl.addEventListener('dblclick', (e) => handleTreeNode(e, 'new'));

  if (playBtn) {
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      destroyEditor(panel);
      revokePanelUrls(panel);
      panel.mode = panel.mode === 'source' ? 'rendered' : 'source';
      bodyEl.innerHTML = panel.mode === 'source' ? sourceBody(panel.node) : renderedBody(panel.node);
      mountEditorIfNeeded(panel, bodyEl);
      mountMediaIfNeeded(panel, bodyEl);
      playBtn.classList.toggle('is-active', panel.mode === 'rendered');
      playBtn.textContent = panel.mode === 'source' ? 'play' : 'src';
      playBtn.title = panel.mode === 'source' ? 'Sestavit / náhled' : 'Zpět na zdroj';
      // .html: po sestavení rovnou otevři sourozence (css/js/md) jako preview vedle
      const fn = (panel.node.filename || panel.node.name || '').toLowerCase();
      if (panel.mode === 'rendered' && (fn.endsWith('.html') || fn.endsWith('.htm'))) {
        openSiblingFiles(panel.node);
        setActive(panel); // hlavní okno zůstává v popředí
      }
    });
  }

  maxBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMax(panel); });
  head.addEventListener('dblclick', (e) => {
    if (e.target.closest('.panel__btn')) return;
    toggleMax(panel);
  });

  // drag
  let dragging = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.panel__btn')) return;
    if (panel.isMax) return;
    bringToFront(el);
    dragging = true;
    head.classList.add('is-dragging');
    const rect = el.getBoundingClientRect();
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    try { head.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  });
  head.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    el.style.left = `${startLeft + (e.clientX - startX)}px`;
    el.style.top = `${startTop + (e.clientY - startY)}px`;
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    head.classList.remove('is-dragging');
    try { head.releasePointerCapture(e.pointerId); } catch {}
    rememberPanelPos(el);
  };
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);

  el.addEventListener('pointerdown', () => {
    bringToFront(el);
    setActive(panel);
  }, true);
}

export function toggleMax(panel) {
  const el = panel.element;
  const maxBtn = el.querySelector('[data-panel-max]');
  if (panel.isMax) {
    const s = panel.savedStyles || {};
    el.style.left = s.left || ''; el.style.top = s.top || '';
    el.style.right = s.right || ''; el.style.bottom = s.bottom || '';
    el.style.width = s.width || ''; el.style.height = s.height || '';
    el.classList.remove('panel--max');
    panel.isMax = false;
    if (maxBtn) { maxBtn.textContent = '▢'; maxBtn.title = 'Maximalizovat'; }
  } else {
    panel.savedStyles = {
      left: el.style.left, top: el.style.top,
      right: el.style.right, bottom: el.style.bottom,
      width: el.style.width, height: el.style.height,
    };
    el.style.left = '8px';
    el.style.top = 'calc(8px + var(--safe-t))';
    el.style.right = '8px';
    el.style.bottom = 'calc(64px + var(--safe-b))'; // místo na nav
    el.style.width = 'auto';
    el.style.height = 'auto';
    el.classList.add('panel--max');
    panel.isMax = true;
    if (maxBtn) { maxBtn.textContent = '▭'; maxBtn.title = 'Obnovit'; }
  }
}

export function closeAllPreviews() {
  for (const p of Array.from(state.previewPanels.values())) closePanel(p);
}

// Shift varianta: zavři všechny preview, otevři jen main (= jediné okno).
export function openMainOnly(node) {
  closeAllPreviews();
  openMain(node);
}

export function openMain(node) {
  if (state.mainPanel) {
    if (state.mainPanel === state.activePanel) state.activePanel = null;
    state.mainPanel.element.remove();
    state.mainPanel = null;
  }
  const panel = createPanel(node, 'main');
  panel.autofocusEditor = true;
  positionPanel(panel);
  document.getElementById('panels').appendChild(panel.element);
  setupPanelInteractions(panel);
  bringToFront(panel.element);
  state.mainPanel = panel;
  syncFromState();
  if (state.panelNavListener) state.panelNavListener();
  setActive(panel);
  refreshOpenLabels();
  return panel;
}

export function openPreview(node) {
  const path = node.path || '/';
  const existing = state.previewPanels.get(path);
  if (existing) {
    bringToFront(existing.element);
    setActive(existing);
    return existing;
  }
  const panel = createPanel(node, 'preview');
  panel.autofocusEditor = true;
  positionPanel(panel);
  document.getElementById('panels').appendChild(panel.element);
  setupPanelInteractions(panel);
  bringToFront(panel.element);
  state.previewPanels.set(path, panel);
  if (state.panelNavListener) state.panelNavListener();
  setActive(panel);
  refreshOpenLabels();
  return panel;
}

// preview, který sleduje focus (otevřený mezerníkem, měněný šipkami)
export function openAsFollower(node) {
  const path = node.path || '/';

  // už je follower na tomhle uzlu? jen do popředí
  if (state.followerPanel && state.followerPanel.path === path) {
    bringToFront(state.followerPanel.element);
    setActive(state.followerPanel);
    return;
  }

  // zavři předchozího followera a zapamatuj si jeho pozici/velikost
  if (state.followerPanel) {
    const el = state.followerPanel.element;
    state.lastFollowerStyles = {
      left: el.style.left, top: el.style.top,
      right: el.style.right, bottom: el.style.bottom,
      width: el.style.width, height: el.style.height,
    };
    closePanel(state.followerPanel);
  }

  // pokud je uzel už otevřený jako běžný preview, povýším ho na followera
  const existing = state.previewPanels.get(path);
  if (existing) {
    existing.autofocusEditor = false;
    state.followerPanel = existing;
    bringToFront(existing.element);
    setActive(existing);
    return;
  }

  // jinak vyrobím nový preview a označím jako follower
  const panel = createPanel(node, 'preview');
  panel.autofocusEditor = false;
  if (state.lastFollowerStyles) {
    const s = state.lastFollowerStyles;
    if (s.left) panel.element.style.left = s.left;
    if (s.top) panel.element.style.top = s.top;
    if (s.right) panel.element.style.right = s.right;
    if (s.bottom) panel.element.style.bottom = s.bottom;
    if (s.width) panel.element.style.width = s.width;
    if (s.height) panel.element.style.height = s.height;
  } else {
    positionPanel(panel);
  }
  document.getElementById('panels').appendChild(panel.element);
  setupPanelInteractions(panel);
  bringToFront(panel.element);
  state.previewPanels.set(path, panel);
  state.followerPanel = panel;
  if (state.panelNavListener) state.panelNavListener();
  setActive(panel);
  refreshOpenLabels();
}

function openSiblingFiles(node) {
  if (!node.path || node.type === 'root') return;
  const parts = node.path.split('/');
  const parentPath = parts.slice(0, -1).join('/');
  for (const n of state.treeNodes) {
    if (n === node) continue;
    if (n.type !== 'file') continue;
    const nParts = (n.path || '').split('/');
    const nParent = nParts.slice(0, -1).join('/');
    if (nParent === parentPath) openPreview(n);
  }
}

export function closePanel(panel) {
  destroyEditor(panel);
  revokePanelUrls(panel);
  panel.element.remove();
  if (panel === state.mainPanel) {
    state.mainPanel = null;
    syncFromState();
  } else state.previewPanels.delete(panel.path);
  if (panel === state.followerPanel) state.followerPanel = null;
  // poslední zavřené okno = reset kaskády (další otevření zase v rohu)
  if (!state.mainPanel && state.previewPanels.size === 0) state.lastPanelPos = null;
  if (state.activePanel === panel) {
    state.activePanel = null;
    // aktivuj nejvyšší zbylý
    const remaining = allPanels();
    if (remaining.length) {
      const top = remaining.reduce((a, b) => (
        Number(a.element.style.zIndex || 0) > Number(b.element.style.zIndex || 0) ? a : b
      ));
      setActive(top);
    }
  }
  if (state.panelNavListener) state.panelNavListener();
  refreshOpenLabels();
}

// --- spodní navigace --------------------------------------------------------

export function renderNav(grid, vp) {
  const dropdown = document.getElementById('nav-dropdown');
  const tabs = document.getElementById('nav-tabs');
  const homeBtn = document.querySelector('[data-home-btn]');
  const homeWrap = document.querySelector('.nav__home');

  // ~/cesta label + breadcrumb aktuální cesty + historie. Volá se po každém recenter.
  const renderRoute = () => {
    homeBtn.textContent = state.currentRootPath ? `~/${state.currentRootPath}/` : '~/';
    homeBtn.title = state.currentRootPath ? `Skok na hlavní strom (~/)` : 'Hlavní strom';
    dropdown.innerHTML = '';

    // breadcrumb ancestrů — jen když nejsme na home
    const crumbs = [];
    if (state.currentRootPath) {
      crumbs.push({ path: '', label: '~/' });
      const segs = state.currentRootPath.split('/');
      for (let i = 0; i < segs.length; i++) {
        const p = segs.slice(0, i + 1).join('/');
        crumbs.push({ path: p, label: `~/${p}/`, current: i === segs.length - 1 });
      }
    }
    for (const c of crumbs) {
      const row = document.createElement('div');
      row.className = 'nav__crumb' + (c.current ? ' nav__crumb--current' : '');
      if (c.current) {
        row.innerHTML = `<span class="nav__crumb-path">${escapeHtml(c.label)}</span>`;
      } else {
        row.innerHTML = `<a class="nav__crumb-path" href="#" data-hist-path="${escapeHtml(c.path)}">${escapeHtml(c.label)}</a>`;
      }
      dropdown.appendChild(row);
    }

    // historie navštívených (bez aktuálního, ten je v crumb)
    if (state.recenterHistory.length) {
      if (crumbs.length) {
        const sep = document.createElement('div');
        sep.className = 'nav__crumb-sep';
        dropdown.appendChild(sep);
      }
      for (const p of state.recenterHistory) {
        const row = document.createElement('div');
        row.className = 'nav__hist';
        row.innerHTML = `
          <a class="nav__hist-path" href="#" data-hist-path="${escapeHtml(p)}">~/${escapeHtml(p)}/</a>
          <button class="nav__hist-close" type="button" data-hist-close="${escapeHtml(p)}" aria-label="Odstranit z historie">×</button>
        `;
        dropdown.appendChild(row);
      }
    }

    if (!crumbs.length && !state.recenterHistory.length) dropdown.classList.add('is-empty');
    else dropdown.classList.remove('is-empty');
  };
  renderRoute();
  state.routeNavListener = renderRoute;

  // taby = všechny otevřené panely
  const renderTabs = () => {
    tabs.innerHTML = '';
    const all = [];
    if (state.mainPanel) all.push(state.mainPanel);
    for (const p of state.previewPanels.values()) all.push(p);
    if (!all.length) {
      const empty = document.createElement('span');
      empty.className = 'nav__empty';
      empty.textContent = 'žádné otevřené okno';
      tabs.appendChild(empty);
      return;
    }
    for (const p of all) {
      const tab = document.createElement('div');
      let cls = 'nav__tab';
      if (p.variant === 'main') cls += ' nav__tab--main';
      if (p === state.activePanel) cls += ' is-active';
      tab.className = cls;
      tab.dataset.path = p.path;
      tab.innerHTML = `
        <span class="nav__tab-name">${escapeHtml(p.node.name)}</span>
        <button class="nav__tab-close" type="button" aria-label="Zavřít">×</button>
      `;
      tabs.appendChild(tab);
    }
  };
  renderTabs();
  state.panelNavListener = renderTabs;

  // dropdown zavírá se sám na hover-off; po kliku potřebuju spolehlivý zavřík
  const closeDropdown = () => {
    homeWrap.classList.remove('is-open');
    if (document.activeElement && homeWrap.contains(document.activeElement)) {
      document.activeElement.blur();
    }
  };

  // klik handlery
  document.getElementById('nav').addEventListener('click', (e) => {
    const homeHit = e.target.closest('[data-home-btn]');
    if (homeHit) {
      // ~/ = vrať mindmapu na skutečný kořen
      recenter('');
      closeDropdown();
      return;
    }
    const histClose = e.target.closest('[data-hist-close]');
    if (histClose) {
      e.preventDefault();
      e.stopPropagation();
      removeFromHistory(histClose.dataset.histClose);
      return;
    }
    const histPath = e.target.closest('[data-hist-path]');
    if (histPath) {
      e.preventDefault();
      recenter(histPath.dataset.histPath);
      closeDropdown();
      return;
    }
    const tabClose = e.target.closest('.nav__tab-close');
    if (tabClose) {
      e.stopPropagation();
      const tab = tabClose.closest('.nav__tab');
      const path = tab.dataset.path;
      if (state.mainPanel?.path === path) closePanel(state.mainPanel);
      else {
        const p = state.previewPanels.get(path);
        if (p) closePanel(p);
      }
      return;
    }
    const tab = e.target.closest('.nav__tab');
    if (tab) {
      const path = tab.dataset.path;
      const panel = state.mainPanel?.path === path ? state.mainPanel : state.previewPanels.get(path);
      if (panel) { bringToFront(panel.element); setActive(panel); }
    }
  });
}
