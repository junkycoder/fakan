// fakan.cz — interaktivní mindmapa ve stylu `tree fakan.cz`
// Root je uprostřed, top-level děti se distribuují do 4 kvadrantů (N/S/E/W)
// podle typu (.md → sever, adresáře → jih, kód → východ, ostatní → západ).
// Render: ASCII tree-znaky do char-grid → jeden <pre> + překryvy pro kliky.

const TREE_URL = './tree.json';
const CHAR_W = 8.4;
const LINE_H = 18;

// --- char grid (Map<"r|c", {n,s,e,w}>) + nodes -------------------------------

const ckey = (r, c) => `${r}|${c}`;

function makeGrid() {
  return {
    conn: new Map(),
    nodes: [],
    minR: Infinity, maxR: -Infinity, minC: Infinity, maxC: -Infinity,
  };
}

function gridTouch(g, r, c) {
  if (r < g.minR) g.minR = r;
  if (r > g.maxR) g.maxR = r;
  if (c < g.minC) g.minC = c;
  if (c > g.maxC) g.maxC = c;
}

function gridConn(g, r, c, d) {
  const k = ckey(r, c);
  let cur = g.conn.get(k);
  if (!cur) { cur = { n: false, s: false, e: false, w: false }; g.conn.set(k, cur); }
  if (d.n) cur.n = true;
  if (d.s) cur.s = true;
  if (d.e) cur.e = true;
  if (d.w) cur.w = true;
  gridTouch(g, r, c);
}

function gridNode(g, r, c, node) {
  g.nodes.push({ row: r, col: c, ...node });
  gridTouch(g, r, c);
  gridTouch(g, r, c + node.name.length - 1);
}

// předá si všechna metadata dítěte do node objektu v gridu
function fileMeta(child) {
  return {
    kind: child.kind || (child.type === 'file' ? 'other' : undefined),
    filename: child.filename,
    slug: child.slug,
    title: child.title,
    content: child.content,
  };
}

const charForDirs = (d) => {
  const k = (d.n?1:0) | ((d.s?1:0)<<1) | ((d.e?1:0)<<2) | ((d.w?1:0)<<3);
  return [' ','│','│','│','─','└','┌','├','─','┘','┐','┤','─','┴','┬','┼'][k];
};

// --- layout: down-body (standardní `tree`) -----------------------------------
// Vrátí nový `body` grid s trunk col = 0 a první dítě na row 0.

function layoutBody(children, pathPrefix = '') {
  const g = makeGrid();
  let cursor = 0;

  const walk = (subs, prefix, parentPath) => {
    const n = subs.length;
    for (let i = 0; i < n; i++) {
      const child = subs[i];
      const isLast = i === n - 1;
      const row = cursor++;
      const path = parentPath ? `${parentPath}/${child.name}` : child.name;

      // pokračující trunk z předků v této řadě
      for (let j = 0; j < prefix.length; j++) {
        if (prefix[j] === '|') gridConn(g, row, j, { n: true, s: true });
      }

      // hlavní konektor (├ nebo └) + 2× ─ + (mezera) + jméno
      const cc = prefix.length;
      gridConn(g, row, cc, { n: true, e: true, s: !isLast });
      gridConn(g, row, cc + 1, { e: true, w: true });
      gridConn(g, row, cc + 2, { e: true, w: true });

      gridNode(g, row, cc + 4, {
        name: child.name,
        type: child.type,
        path,
        hasChildren: !!(child.children && child.children.length),
        ...fileMeta(child),
      });

      if (child.children && child.children.length) {
        const newPrefix = prefix + (isLast ? '    ' : '|   ');
        walk(child.children, newPrefix, path);
      }
    }
  };

  walk(children, '', pathPrefix);
  return g;
}

// --- transformace bodyho -----------------------------------------------------

function flipBodyVertical(body) {
  const r0 = body.minR, r1 = body.maxR;
  const newConn = new Map();
  for (const [k, d] of body.conn) {
    const [r, c] = k.split('|').map(Number);
    const nr = r0 + (r1 - r);
    newConn.set(ckey(nr, c), { n: d.s, s: d.n, e: d.e, w: d.w });
  }
  body.conn = newConn;
  for (const node of body.nodes) {
    node.row = r0 + (r1 - node.row);
  }
}

function flipBodyHorizontal(body) {
  // Zrcadlí horizontálně okolo (minC + maxC)/2; každý uzel se umístí tak,
  // aby jeho PRAVÝ okraj byl tam, kde byl jeho levý → name endCol = mirror(name.col).
  const c0 = body.minC, c1 = body.maxC;
  const newConn = new Map();
  for (const [k, d] of body.conn) {
    const [r, c] = k.split('|').map(Number);
    const nc = c0 + (c1 - c);
    newConn.set(ckey(r, nc), { n: d.n, s: d.s, e: d.w, w: d.e });
  }
  body.conn = newConn;
  for (const node of body.nodes) {
    const endCol = node.col + node.name.length - 1;
    node.col = c0 + (c1 - endCol);
  }
  // bbox zůstává stejné
}

function composeBody(dst, body, dRow, dCol) {
  for (const [k, d] of body.conn) {
    const [r, c] = k.split('|').map(Number);
    gridConn(dst, r + dRow, c + dCol, d);
  }
  for (const node of body.nodes) {
    // přenes všechna metadata uzlu, ne jen subset
    const { row, col, ...rest } = node;
    gridNode(dst, row + dRow, col + dCol, rest);
  }
}

// Odebere konkrétní směry z konektoru na (row, col) v dst gridu.
// Použito pro EAST/WEST trunk: jeho konce nemají pokračovat do prázdna.
function gridClearDirs(g, row, col, dirsToClear) {
  const cur = g.conn.get(ckey(row, col));
  if (!cur) return;
  if (dirsToClear.n) cur.n = false;
  if (dirsToClear.s) cur.s = false;
  if (dirsToClear.e) cur.e = false;
  if (dirsToClear.w) cur.w = false;
}

function bbox(g) {
  const minR = (g.minR === Infinity) ? 0 : g.minR;
  const maxR = (g.maxR === -Infinity) ? 0 : g.maxR;
  const minC = (g.minC === Infinity) ? 0 : g.minC;
  const maxC = (g.maxC === -Infinity) ? 0 : g.maxC;
  return { minR, maxR, minC, maxC, height: maxR - minR + 1, width: maxC - minC + 1 };
}

// --- distribuce do kvadrantů -------------------------------------------------

// Mapování top-level adresářů do kvadrantů.
// SEVER = psaní/myšlení, JIH = práce/výstupy, VÝCHOD = technika, ZÁPAD = identita/kontakt.
const DIR_QUADRANT = {
  // sever
  diary: 'north', texty: 'north', notes: 'north', blog: 'north', zapisky: 'north',
  // jih
  projects: 'south', design: 'south', work: 'south', prace: 'south',
  // východ
  code: 'east', infra: 'east', tech: 'east', src: 'east',
  // západ
  about: 'west', contacts: 'west', kontakt: 'west', kontakty: 'west', ja: 'west', services: 'west',
};

function classify(child) {
  if (child.type === 'dir') {
    return DIR_QUADRANT[child.name.toLowerCase()] || 'south';
  }
  if (child.kind === 'md') return 'north';
  const fn = (child.filename || child.name || '').toLowerCase();
  if (fn.startsWith('.')) return 'east'; // .gitignore patří k technice
  if (fn.endsWith('.txt')) return 'north';
  if (/\.(html|css|js|sh|py|json|ts|tsx)$/.test(fn)) return 'east';
  return 'west';
}

function distribute(children) {
  const q = { north: [], south: [], east: [], west: [] };
  for (const c of children) q[classify(c)].push(c);
  return q;
}

// --- celkový build mindmapy --------------------------------------------------

function buildMindmap(tree) {
  const g = makeGrid();

  // Root
  const rootName = tree.name;
  const rootLen = rootName.length;
  const rootCol = -Math.floor(rootLen / 2);
  const rootRow = 0;
  const rootRight = rootCol + rootLen - 1;
  gridNode(g, rootRow, rootCol, {
    name: rootName,
    type: 'root',
    path: '',
    hasChildren: !!(tree.children && tree.children.length),
  });

  const q = distribute(tree.children || []);

  // Pre-compute EAST/WEST extenty, abychom mohli SOUTH/NORTH posunout
  // dál od rootu, když je horizontální větev vyšší než 1 řádek na stranu.
  let eastInfo = null, westInfo = null;
  if (q.east.length) {
    const body = layoutBody(q.east, '');
    const bb = bbox(body);
    const centerOffset = Math.floor((bb.height - 1) / 2);
    const dRow = rootRow - centerOffset;
    eastInfo = { body, bb, dRow, topRow: dRow + bb.minR, bottomRow: dRow + bb.maxR };
  }
  if (q.west.length) {
    const body = layoutBody(q.west, '');
    flipBodyHorizontal(body);
    const bb = bbox(body);
    const centerOffset = Math.floor((bb.height - 1) / 2);
    const dRow = rootRow - centerOffset;
    westInfo = { body, bb, dRow, topRow: dRow + bb.minR, bottomRow: dRow + bb.maxR };
  }

  let southStart = rootRow + 2;
  if (eastInfo) southStart = Math.max(southStart, eastInfo.bottomRow + 2);
  if (westInfo) southStart = Math.max(southStart, westInfo.bottomRow + 2);

  let northEnd = rootRow - 2;
  if (eastInfo) northEnd = Math.min(northEnd, eastInfo.topRow - 2);
  if (westInfo) northEnd = Math.min(northEnd, westInfo.topRow - 2);

  // SOUTH ---------------------------------------------------------------
  if (q.south.length) {
    const body = layoutBody(q.south, '');
    composeBody(g, body, southStart, 0);
    for (let r = rootRow + 1; r < southStart; r++) {
      gridConn(g, r, 0, { n: true, s: true });
    }
  }

  // NORTH ---------------------------------------------------------------
  if (q.north.length) {
    const body = layoutBody(q.north, '');
    flipBodyVertical(body);
    const bb = bbox(body);
    const dRow = northEnd - bb.maxR;
    composeBody(g, body, dRow, 0);
    for (let r = rootRow - 1; r > northEnd; r--) {
      gridConn(g, r, 0, { n: true, s: true });
    }
  }

  // EAST ----------------------------------------------------------------
  if (eastInfo) {
    const { body, bb, dRow } = eastInfo;
    const trunkCol = rootRight + 4;
    composeBody(g, body, dRow, trunkCol);
    for (let c = rootRight + 1; c < trunkCol; c++) {
      gridConn(g, rootRow, c, { e: true, w: true });
    }
    gridConn(g, rootRow, trunkCol, { w: true });
    gridClearDirs(g, dRow + bb.minR, trunkCol, { n: true });
    gridClearDirs(g, dRow + bb.maxR, trunkCol, { s: true });
  }

  // WEST ----------------------------------------------------------------
  if (westInfo) {
    const { body, bb, dRow } = westInfo;
    const trunkCol = rootCol - 4;
    const dCol = trunkCol - bb.maxC;
    composeBody(g, body, dRow, dCol);
    for (let c = trunkCol + 1; c < rootCol; c++) {
      gridConn(g, rootRow, c, { e: true, w: true });
    }
    gridConn(g, rootRow, trunkCol, { e: true });
    gridClearDirs(g, dRow + bb.minR, trunkCol, { n: true });
    gridClearDirs(g, dRow + bb.maxR, trunkCol, { s: true });
  }

  return g;
}

// --- render do <pre> + překryvy ---------------------------------------------

function renderGrid(grid) {
  const bb = bbox(grid);
  // 2D pole znaků
  const rows = [];
  for (let r = 0; r < bb.height; r++) {
    rows.push(new Array(bb.width).fill(' '));
  }

  // konektory
  for (const [k, d] of grid.conn) {
    const [r, c] = k.split('|').map(Number);
    const localR = r - bb.minR;
    const localC = c - bb.minC;
    rows[localR][localC] = charForDirs(d);
  }

  // uzly přebijí konektory (text)
  const nodeMeta = []; // {row, col, len, ...node}
  for (const node of grid.nodes) {
    const localR = node.row - bb.minR;
    const localC = node.col - bb.minC;
    for (let i = 0; i < node.name.length; i++) {
      rows[localR][localC + i] = node.name[i];
    }
    nodeMeta.push({ ...node, localRow: localR, localCol: localC });
  }

  // sestavení HTML pre s obarvenými uzly
  // Pro každý řádek: postavíme řetězec a vložíme <span> kolem uzlů.
  // Indexujeme uzly podle (row,col-rozsahu).
  const html = [];
  const nodesByRow = new Map();
  for (const n of nodeMeta) {
    if (!nodesByRow.has(n.localRow)) nodesByRow.set(n.localRow, []);
    nodesByRow.get(n.localRow).push(n);
  }
  for (const arr of nodesByRow.values()) arr.sort((a, b) => a.localCol - b.localCol);

  for (let r = 0; r < bb.height; r++) {
    const arr = nodesByRow.get(r) || [];
    let cursor = 0;
    const line = rows[r];
    let out = '';
    for (const n of arr) {
      // text před uzlem (jen konektory)
      out += escapeHtml(line.slice(cursor, n.localCol).join(''));
      const cls = nodeClass(n);
      out += `<span class="n ${cls}">${escapeHtml(n.name)}</span>`;
      cursor = n.localCol + n.name.length;
    }
    out += escapeHtml(line.slice(cursor).join(''));
    html.push(out);
  }

  return { html: html.join('\n'), nodeMeta, bbox: bb };
}

function nodeClass(n) {
  if (n.type === 'root') return 'n--root';
  if (n.type === 'dir') return n.hasChildren ? 'n--dir' : 'n--dir n--empty';
  if (n.kind === 'md') return 'n--doc';
  const fn = (n.filename || n.name || '').toLowerCase();
  if (/\.(html|css|js|sh|py|json|ts|tsx)$/.test(fn)) return 'n--code';
  return 'n--other';
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// --- DOM rendering -----------------------------------------------------------

function paint(map, hits, grid) {
  const { html, nodeMeta, bbox: bb } = renderGrid(grid);
  map.innerHTML = html;

  // překryvy pro kliky
  hits.innerHTML = '';
  for (const n of nodeMeta) {
    const el = document.createElement('button');
    el.className = 'hit';
    el.type = 'button';
    el.dataset.path = n.path || '/';
    el.dataset.type = n.type;
    el.style.top = `${n.localRow * LINE_H}px`;
    el.style.left = `${n.localCol * CHAR_W}px`;
    el.style.width = `${n.name.length * CHAR_W}px`;
    el.setAttribute('aria-label', `${n.type === 'root' ? 'root ' : ''}${n.name}`);
    hits.appendChild(el);
  }

  return bb;
}

// --- pan / zoom --------------------------------------------------------------

function setupViewport(canvas, viewport, getView) {
  let scale = 1;
  let tx = 0, ty = 0;
  let panning = false;
  let startX = 0, startY = 0, startTx = 0, startTy = 0;

  const apply = () => {
    viewport.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };

  const nodeCenterLocal = (node, bb) => {
    const leftCol = node.col - bb.minC;
    return {
      x: (leftCol + node.name.length / 2) * CHAR_W,
      y: (node.row - bb.minR + 0.5) * LINE_H,
    };
  };

  const panToNode = (node) => {
    const v = getView();
    if (!v || !node) return;
    const { x, y } = nodeCenterLocal(node, v.bb);
    tx = canvas.clientWidth / 2 - x * scale;
    ty = canvas.clientHeight / 2 - y * scale;
    apply();
  };

  const center = () => {
    const v = getView();
    if (!v || !v.rootNode) return;
    scale = 1;
    panToNode(v.rootNode);
  };

  const ensureVisible = (node, margin = 60) => {
    const v = getView();
    if (!v || !node) return;
    const { x, y } = nodeCenterLocal(node, v.bb);
    const sx = x * scale + tx;
    const sy = y * scale + ty;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (sx > margin && sx < w - margin && sy > margin && sy < h - margin) return;
    panToNode(node);
  };

  // pan
  canvas.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.hit')) return;
    panning = true;
    canvas.classList.add('is-panning');
    startX = e.clientX; startY = e.clientY;
    startTx = tx; startTy = ty;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!panning) return;
    tx = startTx + (e.clientX - startX);
    ty = startTy + (e.clientY - startY);
    apply();
  });
  const endPan = (e) => {
    if (!panning) return;
    panning = false;
    canvas.classList.remove('is-panning');
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
  };
  canvas.addEventListener('pointerup', endPan);
  canvas.addEventListener('pointercancel', endPan);

  // zoom
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    const newScale = Math.min(4, Math.max(0.3, scale * factor));
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const wx = (cx - tx) / scale;
    const wy = (cy - ty) / scale;
    scale = newScale;
    tx = cx - wx * scale;
    ty = cy - wy * scale;
    apply();
  }, { passive: false });

  return { center, apply, panToNode, ensureVisible };
}

// --- minimal markdown renderer ----------------------------------------------
// Podmnožina: nadpisy, odstavce, **bold**, *italic*, `code`, ``` block ```,
// `- ` seznamy, [text](url) odkazy, horizontální čára `---`.

function renderMarkdown(md) {
  let s = String(md || '');

  // 1) vytáhneme code-blocky (``` ... ```) jako placeholdery, ať nepodléhají inline transformacím
  const blocks = [];
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre class="md-code"><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return ` B${blocks.length - 1} `;
  });

  // 2) escape zbytku
  s = escapeHtml(s);

  // 3) inline code (`...`)
  s = s.replace(/`([^`\n]+)`/g, '<code class="md-inline">$1</code>');

  // 4) odkazy [text](url) — povolíme jen http(s), mailto, relativní '/'
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    const safe = /^(https?:|mailto:|\/|#)/i.test(url) ? url : '#';
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${text}</a>`;
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
    if (t.startsWith(' B')) return t;
    if (isBlock.test(t)) return t;
    return `<p>${t.replace(/\n/g, '<br>')}</p>`;
  }).filter(Boolean).join('\n');

  // 10) vrátíme code-blocky zpět
  return paras.replace(/ B(\d+) /g, (_, i) => blocks[Number(i)]);
}

// --- panel windows ----------------------------------------------------------
// Víc oken zároveň. Tažení za hlavičku, resize přes CSS `resize: both`.
// Klik na uzel = nový panel; existujicí panel se vytáhne dopředu.

const openPanels = new Map(); // path → panel element
let panelZ = 100;

function panelBodyHtml(node) {
  if (node.type === 'root') {
    return '<p>Osobní web. Vyberte větev nebo list.</p>';
  }
  if (node.type === 'dir') {
    return node.hasChildren
      ? '<p>Adresář — uvnitř najdete listy.</p>'
      : '<p class="empty">Zatím prázdné.</p>';
  }
  if (node.kind === 'md') {
    if (node.content && node.content.trim()) {
      return `<div class="md">${renderMarkdown(node.content)}</div>`;
    }
    return `<p class="empty">Prázdný soubor <code>${escapeHtml(node.filename || node.name)}</code>.</p>`;
  }
  return `<p>Soubor <code>${escapeHtml(node.filename || node.name)}</code>.</p>`;
}

function bringToFront(panel) {
  panelZ++;
  panel.style.zIndex = String(panelZ);
}

function setupPanelDrag(panel) {
  const head = panel.querySelector('[data-panel-head]');
  let dragging = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;

  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('[data-panel-close]')) return;
    bringToFront(panel);
    dragging = true;
    head.classList.add('is-dragging');
    const rect = panel.getBoundingClientRect();
    // přepneme z right/bottom na left/top, aby šel volně posouvat
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    head.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  head.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    panel.style.left = `${startLeft + (e.clientX - startX)}px`;
    panel.style.top = `${startTop + (e.clientY - startY)}px`;
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    head.classList.remove('is-dragging');
    try { head.releasePointerCapture(e.pointerId); } catch {}
  };
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);
}

function openPanel(node) {
  const path = node.path || '/';
  const existing = openPanels.get(path);
  if (existing) {
    bringToFront(existing);
    return existing;
  }

  const panel = document.createElement('section');
  panel.className = 'panel';
  panel.dataset.path = path;
  const displayPath = path === '/' ? 'fakan.cz' : path;
  panel.innerHTML = `
    <header class="panel__head" data-panel-head>
      <span class="panel__path">${escapeHtml(displayPath)}</span>
      <button class="panel__close" type="button" data-panel-close aria-label="Zavřít">×</button>
    </header>
    <div class="panel__body">${panelBodyHtml(node)}</div>
  `;

  // pozice se zalomeným stagger offsetem
  const stack = openPanels.size;
  panel.style.right = `${16 + stack * 28}px`;
  panel.style.top = `${16 + stack * 28}px`;

  document.getElementById('panels').appendChild(panel);
  openPanels.set(path, panel);
  bringToFront(panel);
  setupPanelDrag(panel);

  panel.querySelector('[data-panel-close]').addEventListener('click', () => {
    panel.remove();
    openPanels.delete(path);
  });
  panel.addEventListener('pointerdown', () => bringToFront(panel), true);

  return panel;
}

// --- záložky (top-level sekce) ----------------------------------------------

function renderTabs(grid, vp) {
  const tabs = document.getElementById('tabs');
  const topDirs = grid.nodes.filter((n) => n.type === 'dir' && n.path && !n.path.includes('/'));
  // root jako první (návrat domů)
  const rootNode = grid.nodes.find((n) => n.type === 'root');
  const items = rootNode ? [rootNode, ...topDirs] : topDirs;

  tabs.innerHTML = '';
  for (const item of items) {
    const a = document.createElement('a');
    a.className = 'tab';
    a.dataset.path = item.path || '/';
    a.href = '#';
    a.textContent = item.type === 'root' ? 'home' : item.name;
    tabs.appendChild(a);
  }

  tabs.addEventListener('click', (e) => {
    const a = e.target.closest('.tab');
    if (!a) return;
    e.preventDefault();
    const path = a.dataset.path;
    const node = grid.nodes.find((n) => (n.path || '') === (path === '/' ? '' : path));
    if (!node) return;
    focusNode(node);
    vp.panToNode(node);
    if (node.type !== 'root') openPanel(node);
    updateActiveTab(path);
  });
}

function updateActiveTab(path) {
  document.querySelectorAll('.tab').forEach((el) => {
    el.classList.toggle('tab--active', el.dataset.path === path);
  });
}

// --- klávesnice: šipky + Enter ----------------------------------------------

let focusedPath = '';

function focusNode(node) {
  focusedPath = node.path || '';
  document.querySelectorAll('.hit--focus').forEach((el) => el.classList.remove('hit--focus'));
  const sel = `.hit[data-path="${cssEscapePath(focusedPath || '/')}"]`;
  const el = document.querySelector(sel);
  if (el) el.classList.add('hit--focus');
}

function cssEscapePath(p) {
  if (window.CSS && CSS.escape) return CSS.escape(p);
  return p.replace(/["\\]/g, '\\$&');
}

function findNeighbor(current, direction, nodes) {
  const cx = current.col + current.name.length / 2;
  const cy = current.row;
  let best = null;
  let bestScore = Infinity;
  for (const n of nodes) {
    if (n === current) continue;
    const x = n.col + n.name.length / 2;
    const y = n.row;
    const dx = x - cx;
    const dy = y - cy;
    let primary = 0, secondary = 0;
    if (direction === 'up') {
      if (dy >= 0) continue;
      primary = -dy; secondary = Math.abs(dx);
    } else if (direction === 'down') {
      if (dy <= 0) continue;
      primary = dy; secondary = Math.abs(dx);
    } else if (direction === 'left') {
      if (dx >= 0) continue;
      primary = -dx; secondary = Math.abs(dy);
    } else if (direction === 'right') {
      if (dx <= 0) continue;
      primary = dx; secondary = Math.abs(dy);
    } else continue;
    // kolmá vzdálenost váží 2,5× — preferujeme uzly „v ose"
    const score = primary + secondary * 2.5;
    if (score < bestScore) { bestScore = score; best = n; }
  }
  return best;
}

function setupKeyboard(grid, vp) {
  window.addEventListener('keydown', (e) => {
    // pokud uživatel píše do inputu / contenteditable, šipky nepřebíráme
    const tgt = e.target;
    const tag = tgt && tgt.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (tgt && tgt.isContentEditable)) return;

    if (e.key === '0') { vp.center(); return; }

    const dirMap = {
      ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
      k: 'up', j: 'down', h: 'left', l: 'right',
    };
    if (e.key in dirMap) {
      e.preventDefault();
      const current = grid.nodes.find((n) => (n.path || '') === focusedPath)
        || grid.nodes.find((n) => n.type === 'root');
      if (!current) return;
      const next = findNeighbor(current, dirMap[e.key], grid.nodes);
      if (next) {
        focusNode(next);
        vp.ensureVisible(next);
      }
      return;
    }

    if (e.key === 'Enter' || e.key === ' ') {
      const node = grid.nodes.find((n) => (n.path || '') === focusedPath);
      if (node) {
        e.preventDefault();
        openPanel(node);
      }
      return;
    }

    if (e.key === 'Escape') {
      // zavře nejvyšší (poslední přidaný) panel
      const last = Array.from(openPanels.values()).pop();
      if (last) {
        const path = last.dataset.path;
        last.remove();
        openPanels.delete(path);
      }
    }
  });
}

// --- boot --------------------------------------------------------------------

async function boot() {
  const res = await fetch(TREE_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`tree.json: ${res.status}`);
  const tree = await res.json();

  const canvas = document.getElementById('canvas');
  const viewport = document.getElementById('viewport');
  const map = document.getElementById('map');
  const hits = document.getElementById('hits');

  const grid = buildMindmap(tree);
  const bb = paint(map, hits, grid);
  const rootNode = grid.nodes.find((n) => n.type === 'root');

  const vp = setupViewport(canvas, viewport, () => ({ bb, rootNode }));
  requestAnimationFrame(vp.center);
  window.addEventListener('resize', vp.center);

  renderTabs(grid, vp);
  setupKeyboard(grid, vp);
  if (rootNode) focusNode(rootNode);

  hits.addEventListener('click', (e) => {
    const el = e.target.closest('.hit');
    if (!el) return;
    const path = el.dataset.path;
    const node = grid.nodes.find((n) => (n.path || '') === (path === '/' ? '' : path));
    if (!node) return;
    focusNode(node);
    openPanel(node);
    updateActiveTab(path);
  });
}

boot().catch((err) => {
  console.error(err);
  const map = document.getElementById('map');
  if (map) map.textContent = `chyba načítání: ${err.message}`;
});
