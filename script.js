// fakan.cz — interaktivní mindmapa ve stylu `tree fakan.cz`
// Root je uprostřed, top-level děti se distribuují do 4 kvadrantů (N/S/E/W)
// podle typu (.md → sever, adresáře → jih, kód → východ, ostatní → západ).
// Render: ASCII tree-znaky do char-grid → jeden <pre> + překryvy pro kliky.

import { mountEditor } from './editor.js';

const LS_EDIT_PREFIX = 'fakan:edit:';
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
    raw: child.raw,
    url: child.url,
    fetched_at: child.fetched_at,
  };
}

const charForDirs = (d) => {
  const k = (d.n?1:0) | ((d.s?1:0)<<1) | ((d.e?1:0)<<2) | ((d.w?1:0)<<3);
  return [' ','│','│','│','─','└','┌','├','─','┘','┐','┤','─','┴','┬','┼'][k];
};

// --- layout: down-body (standardní `tree`) -----------------------------------
// Vrátí nový `body` grid s trunk col = 0 a první dítě na row 0.
// `sepTop` = počet prázdných řádků mezi top-level dětmi (vizuální oddělení skupin).

function layoutBody(children, pathPrefix = '', sepTop = 1) {
  const g = makeGrid();
  g.topRows = []; // řádky top-level dětí — pro vystředění root spojnice mimo node
  let cursor = 0;

  const walk = (subs, prefix, parentPath, depth) => {
    const n = subs.length;
    for (let i = 0; i < n; i++) {
      // prázdný řádek mezi top-level dětmi: vždy, ne jen u skupin s children.
      // Důvod: dává root spojnici šanci padnout do gap místo na node;
      // zároveň vizuálně rozvolňuje hustou řadu souborů.
      if (depth === 0 && i > 0 && sepTop > 0) {
        for (let s = 0; s < sepTop; s++) {
          const blank = cursor++;
          for (let j = 0; j < prefix.length; j++) {
            if (prefix[j] === '|') gridConn(g, blank, j, { n: true, s: true });
          }
          gridConn(g, blank, prefix.length, { n: true, s: true });
        }
      }

      const child = subs[i];
      const isLast = i === n - 1;
      const row = cursor++;
      if (depth === 0) g.topRows.push(row);
      // pro file uzly konstruuj path z `filename` (web uzly mají `name` jen jako display label);
      // pro dir je filename undefined → fallback na name.
      const seg = child.type === 'file' ? (child.filename || child.name) : child.name;
      const path = parentPath ? `${parentPath}/${seg}` : seg;

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
        walk(child.children, newPrefix, path, depth + 1);
      }
    }
  };

  walk(children, '', pathPrefix, 0);
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

// Vrátí řádek body, na který má padnout root spojnice EAST/WEST tak,
// aby trefila mezeru mezi top-level dětmi (ne přímo název souboru).
// - 1 dítě: padne na něj (single node nemá kam jinam).
// - sudý počet: gap mezi dvěma prostředními top-row.
// - lichý počet: gap nad prostředním top-row (asymetrie, ale spojnice nepřebije node).
function midGapRow(topRows, _bb) {
  const n = topRows.length;
  if (n <= 1) return topRows[0] || 0;
  if (n % 2 === 0) {
    const lo = topRows[n / 2 - 1];
    const hi = topRows[n / 2];
    return Math.floor((lo + hi) / 2);
  }
  const midIdx = (n - 1) / 2;
  const mid = topRows[midIdx];
  if (midIdx > 0) {
    const above = topRows[midIdx - 1];
    return Math.floor((above + mid) / 2);
  }
  return mid;
}

// --- celkový build mindmapy --------------------------------------------------

// Vizuální zvětšení rootu — musí ladit s CSS .labels .n--root transform: scale(...).
const ROOT_SCALE = 1.4;

function buildMindmap(tree, basePath = '') {
  const g = makeGrid();

  // Root (vizuální — může to být reálný kořen i jakákoli složka jako virtuální root)
  const rootName = tree.name;
  const rootLen = rootName.length;
  const rootCol = -Math.floor(rootLen / 2);
  const rootRow = 0;
  const rootRight = rootCol + rootLen - 1;
  // Root je vykreslen větším fontem → vizuálně přesahuje grid o `rootPad`
  // znaků na každou stranu. EAST/WEST trunky musí začínat až za touto hranicí,
  // jinak by se spojnice překrývaly s textem rootu.
  const rootPad = Math.ceil(((ROOT_SCALE - 1) / 2) * rootLen);
  const rootRightVis = rootRight + rootPad;
  const rootLeftVis = rootCol - rootPad;
  gridNode(g, rootRow, rootCol, {
    name: rootName,
    type: 'root',
    path: basePath,
    hasChildren: !!(tree.children && tree.children.length),
  });

  const q = distribute(tree.children || []);

  // Pre-compute EAST/WEST extenty, abychom mohli SOUTH/NORTH posunout
  // dál od rootu, když je horizontální větev vyšší než 1 řádek na stranu.
  // Cíl: rootRow padne do gap mezi top-level dětmi, aby napojení od rootu
  // bylo `┤`/`├` v prázdnu, ne `┼` přes název souboru.
  let eastInfo = null, westInfo = null;
  if (q.east.length) {
    const body = layoutBody(q.east, basePath);
    const bb = bbox(body);
    const midRow = midGapRow(body.topRows, bb);
    const dRow = rootRow - midRow;
    eastInfo = { body, bb, dRow, topRow: dRow + bb.minR, bottomRow: dRow + bb.maxR };
  }
  if (q.west.length) {
    const body = layoutBody(q.west, basePath);
    // flip nemění řádky, jen sloupce, takže midRow lze spočítat až po
    flipBodyHorizontal(body);
    const bb = bbox(body);
    const midRow = midGapRow(body.topRows, bb);
    const dRow = rootRow - midRow;
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
    const body = layoutBody(q.south, basePath);
    composeBody(g, body, southStart, 0);
    for (let r = rootRow + 1; r < southStart; r++) {
      gridConn(g, r, 0, { n: true, s: true });
    }
  }

  // NORTH ---------------------------------------------------------------
  if (q.north.length) {
    const body = layoutBody(q.north, basePath);
    flipBodyVertical(body);
    const bb = bbox(body);
    const dRow = northEnd - bb.maxR;
    composeBody(g, body, dRow, 0);
    for (let r = rootRow - 1; r > northEnd; r--) {
      gridConn(g, r, 0, { n: true, s: true });
    }
  }

  // EAST ----------------------------------------------------------------
  // Trunk je dál od rootu o rootPad + 5: 2 prázdné cols (mezera za rootem),
  // pak 3× `─`, pak `┤`/`├`/`┼`. Mezera respektuje vizuální šířku rootu.
  if (eastInfo) {
    const { body, bb, dRow } = eastInfo;
    const trunkCol = rootRightVis + 5;
    composeBody(g, body, dRow, trunkCol);
    for (let c = rootRightVis + 2; c < trunkCol; c++) {
      gridConn(g, rootRow, c, { e: true, w: true });
    }
    gridConn(g, rootRow, trunkCol, { w: true });
    gridClearDirs(g, dRow + bb.minR, trunkCol, { n: true });
    gridClearDirs(g, dRow + bb.maxR, trunkCol, { s: true });
  }

  // WEST ----------------------------------------------------------------
  if (westInfo) {
    const { body, bb, dRow } = westInfo;
    const trunkCol = rootLeftVis - 5;
    const dCol = trunkCol - bb.maxC;
    composeBody(g, body, dRow, dCol);
    for (let c = trunkCol + 1; c <= rootLeftVis - 2; c++) {
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
  // 2D pole znaků — jen konektory, žádné názvy.
  // Názvy jdou do .labels overlay, aby každá hloubka mohla mít vlastní font-size
  // bez rozbití char gridu.
  const rows = [];
  // Math.max chrání před RangeError u patologického bbox (width/height ≤ 0 nebo NaN)
  const H = Math.max(0, bb.height | 0);
  const W = Math.max(0, bb.width | 0);
  for (let r = 0; r < H; r++) {
    rows.push(new Array(W).fill(' '));
  }

  for (const [k, d] of grid.conn) {
    const [r, c] = k.split('|').map(Number);
    const localR = r - bb.minR;
    const localC = c - bb.minC;
    rows[localR][localC] = charForDirs(d);
  }

  const nodeMeta = grid.nodes.map((node) => ({
    ...node,
    localRow: node.row - bb.minR,
    localCol: node.col - bb.minC,
  }));

  const html = rows.map((line) => escapeHtml(line.join(''))).join('\n');
  return { html, nodeMeta, bbox: bb };
}

function nodeClass(n) {
  let base;
  if (n.type === 'root') {
    base = 'n--root n--depth-0';
  } else {
    const depth = (n.path || '').split('/').filter(Boolean).length;
    base = `n--depth-${Math.min(depth, 5)}`;
    if (n.type === 'dir') base += n.hasChildren ? ' n--dir' : ' n--dir n--empty';
    else if (n.kind === 'web') base += ' n--web';
    else if (n.kind === 'md') base += ' n--doc';
    else {
      const fn = (n.filename || n.name || '').toLowerCase();
      if (/\.(html?|css|scss|sass|less|m?js|cjs|jsx|tsx?|vue|svelte|sh|bash|zsh|py|rb|erb|rake|gemspec|ru|go|rs|java|kt|kts|scala|clj|cpp?|cc|cxx|hp?p?|swift|php|pl|lua|r|jl|ex|exs|dart|zig|nim|cr|hs|ml|fs|sql|json5?|yaml|yml|toml|xml|ini|conf|env|lock)$/.test(fn)) base += ' n--code';
      else base += ' n--other';
    }
  }
  return base;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// --- DOM rendering -----------------------------------------------------------

function paint(map, labels, hits, grid) {
  const { html, nodeMeta, bbox: bb } = renderGrid(grid);
  map.innerHTML = html;

  // popisky jako overlay — mimo char grid, vlastní transform per hloubka.
  // data-quadrant řídí transform-origin (west = right, ostatní = left).
  labels.innerHTML = '';
  for (const n of nodeMeta) {
    const el = document.createElement('span');
    el.className = `n ${nodeClass(n)}`;
    if (n.path != null) el.dataset.nodePath = n.path || '/';
    if (n.quadrant) el.dataset.quadrant = n.quadrant;
    el.textContent = n.name;
    el.style.top = `${n.localRow * LINE_H}px`;
    el.style.left = `${n.localCol * CHAR_W}px`;
    labels.appendChild(el);
  }

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

// --- media detekce ----------------------------------------------------------
// Audio / video / image / pdf — pro panel typu 'rendered' se nabídne přehrávač
// místo zdrojového vimu (binární data textový editor stejně neumí).

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.ogv', '.ogg', '.avi', '.mkv', '.m4v']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.flac', '.aac', '.opus', '.oga']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.bmp', '.ico']);
const PDF_EXTS = new Set(['.pdf']);

function fileExt(node) {
  const n = (node?.filename || node?.name || '').toLowerCase();
  const i = n.lastIndexOf('.');
  return i >= 0 ? n.slice(i) : '';
}

function mediaKind(node) {
  if (!node || node.type !== 'file') return null;
  // .ogg může být audio i video — ext-based fallback to audio
  const ext = fileExt(node);
  if (VIDEO_EXTS.has(ext) && ext !== '.ogg') return 'video';
  if (AUDIO_EXTS.has(ext) || ext === '.ogg') return 'audio';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (PDF_EXTS.has(ext)) return 'pdf';
  return null;
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

// --- okna (panely) ----------------------------------------------------------
// Klik = jedno velké hlavní okno (replace).
// Cmd/Ctrl+Klik = malý preview panel (additive).
// Drag za hlavičku, doubleclick maximalizuje, resize roh.
// Play/build tlačítko přepíná mezi zdrojákem a vyrendrovaným náhledem.

let mainPanel = null;          // { element, node, path, mode, isMax, savedStyles }
const previewPanels = new Map(); // path → panel
let activePanel = null;          // okno s yellow headerem
let followerPanel = null;        // náhled, který sleduje šipkový focus
let lastFollowerStyles = null;   // pozice/velikost zachovaná mezi instancemi followera
let lastPanelPos = null;         // {left, top} v px posledního umístěného/přesunutého panelu
let panelZ = 100;
let panelNavListener = null;     // callback do nav re-renderu (taby)
let routeNavListener = null;     // callback do nav re-renderu (home / .. / historie)
let recenterHistory = [];        // navštívené rooty (bez aktuálního), nejnovější první
let treeNodes = [];              // všechny uzly, pro sourozeneckou auto-otevírku

// --- re-rooting + tree index (module-level, aktualizováno při rebuild) -------
let originalTree = null;       // celý strom načtený při bootu
let currentRootPath = '';      // path, který je momentálně středem mindmapy
let currentBbox = null;        // bbox aktuálního renderu (pro vp.center)
let viewportApi = null;        // { center, panToNode, ensureVisible }
let byPath = new Map();        // path → node (pro klávesnici, panely, recenter)
let childrenByPath = new Map();
let topQuadrant = new Map();   // top-level path → quadrant

function topLevelAncestor(nodePath, rootPath) {
  let p = nodePath;
  while (true) {
    const parts = p.split('/');
    const parent = parts.slice(0, -1).join('/');
    if (parent === rootPath) return p;
    if (!parent) return p;
    p = parent;
  }
}

function buildTreeIndex(nodes) {
  byPath.clear();
  childrenByPath.clear();
  topQuadrant.clear();
  for (const n of nodes) byPath.set(n.path || '', n);
  for (const n of nodes) {
    if (n.type === 'root') continue;
    const parts = n.path.split('/');
    const parentPath = parts.slice(0, -1).join('/');
    if (!childrenByPath.has(parentPath)) childrenByPath.set(parentPath, []);
    childrenByPath.get(parentPath).push(n);
  }
  // top-level vůči aktuálnímu středu = parent == currentRootPath
  const tops = childrenByPath.get(currentRootPath) || [];
  for (const n of tops) topQuadrant.set(n.path, classify(n));
  // přiřaď kvadrant všem potomkům (zděděný od top-level předka)
  for (const n of nodes) {
    if (n.type === 'root') { n.quadrant = null; continue; }
    const top = topLevelAncestor(n.path, currentRootPath);
    n.quadrant = topQuadrant.get(top);
  }
}

function findSubtree(tree, path) {
  if (!path) return tree;
  const parts = path.split('/');
  let cur = tree;
  for (const p of parts) {
    if (!cur.children) return null;
    cur = cur.children.find((c) => c.name === p);
    if (!cur) return null;
  }
  return cur;
}

function rebuildMindmap(focusPath) {
  if (!originalTree) return;
  const sub = findSubtree(originalTree, currentRootPath);
  if (!sub) return;
  const grid = buildMindmap(sub, currentRootPath);
  const map = document.getElementById('map');
  const labels = document.getElementById('labels');
  const hits = document.getElementById('hits');
  // pořadí: index nejdřív (vyplní n.quadrant), pak paint (čte ho pro data-quadrant)
  treeNodes = grid.nodes;
  buildTreeIndex(grid.nodes);
  loadAllEditOverrides(grid.nodes);
  currentBbox = paint(map, labels, hits, grid);
  const rootNode = grid.nodes.find((n) => n.type === 'root');
  const target = focusPath != null
    ? (byPath.get(focusPath) || rootNode)
    : rootNode;
  if (target) focusNode(target);
  refreshOpenLabels();
  if (viewportApi) {
    requestAnimationFrame(viewportApi.center);
  }
}

function recenter(path) {
  const next = path || '';
  if (next === currentRootPath) return;
  // ulož předchozí root do historie (dedup, cap)
  if (currentRootPath) {
    recenterHistory = recenterHistory.filter((p) => p !== currentRootPath);
    recenterHistory.unshift(currentRootPath);
    if (recenterHistory.length > 30) recenterHistory.length = 30;
  }
  // nový root nesmí být zároveň v historii
  recenterHistory = recenterHistory.filter((p) => p !== next);
  currentRootPath = next;
  rebuildMindmap();
  if (routeNavListener) routeNavListener();
}

function removeFromHistory(path) {
  recenterHistory = recenterHistory.filter((p) => p !== path);
  if (routeNavListener) routeNavListener();
}

function allPanels() {
  const out = [];
  if (mainPanel) out.push(mainPanel);
  for (const p of previewPanels.values()) out.push(p);
  return out;
}

function setActive(panel) {
  if (activePanel === panel) return;
  if (activePanel) activePanel.element.classList.remove('is-active');
  activePanel = panel;
  if (panel) panel.element.classList.add('is-active');
  if (panelNavListener) panelNavListener();
}

function pathLabel(node) {
  const p = node.path || '';
  if (!p) return '~/';
  // dir → trailing slash; root je '~/'
  return '~/' + (node.type === 'dir' ? `${p}/` : p);
}

// Rendering ASCII stromu pro panel (statický pre s inline node spans).
// Reuse char-grid logiky z buildMindmap → renderGrid, ale s texty inline ve <pre>.
function renderTreeInlineHTML(grid) {
  const bb = bbox(grid);
  const rows = [];
  const H = Math.max(0, bb.height | 0);
  const W = Math.max(0, bb.width | 0);
  for (let r = 0; r < H; r++) rows.push(new Array(W).fill(' '));
  for (const [k, d] of grid.conn) {
    const [r, c] = k.split('|').map(Number);
    rows[r - bb.minR][c - bb.minC] = charForDirs(d);
  }
  for (const node of grid.nodes) {
    const localR = node.row - bb.minR;
    const localC = node.col - bb.minC;
    for (let i = 0; i < node.name.length; i++) rows[localR][localC + i] = node.name[i];
  }
  const nodesByRow = new Map();
  for (const n of grid.nodes) {
    const r = n.row - bb.minR;
    if (!nodesByRow.has(r)) nodesByRow.set(r, []);
    nodesByRow.get(r).push({ ...n, localCol: n.col - bb.minC });
  }
  for (const arr of nodesByRow.values()) arr.sort((a, b) => a.localCol - b.localCol);
  const html = [];
  for (let r = 0; r < H; r++) {
    const arr = nodesByRow.get(r) || [];
    let cursor = 0;
    const line = rows[r];
    let out = '';
    for (const n of arr) {
      out += escapeHtml(line.slice(cursor, n.localCol).join(''));
      const dp = n.path == null ? '/' : (n.path || '/');
      out += `<span class="n ${nodeClass(n)}" data-path="${escapeHtml(dp)}" data-type="${escapeHtml(n.type)}" role="button" tabindex="0">${escapeHtml(n.name)}</span>`;
      cursor = n.localCol + n.name.length;
    }
    out += escapeHtml(line.slice(cursor).join(''));
    html.push(out);
  }
  return html.join('\n');
}

function renderDirTree(dirNode) {
  const sub = findSubtree(originalTree, dirNode.path);
  if (!sub) return '<p class="panel__note empty">Strom nenalezen.</p>';
  const grid = buildMindmap(sub, dirNode.path);
  return `<pre class="src-tree">${renderTreeInlineHTML(grid)}</pre>`;
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
      const srcdoc = node.raw.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
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
      const srcdoc = idx.raw.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
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
  const idx = byPath.get((node.path || '') + '/index.html');
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
// Pravidla:
// - statický deploy (žádný source connected) → node.path je reálná URL
// - FSA (rootHandle) → node má _handle; blob z handle.getFile()
// - snapshot (uploadedSnapshot) → file má _file (z File API) nebo raw/content
// - GitHub (githubSpec) → text v raw; binární media nejsou fetchnutá
// Vrací Blob (await) — volající si udělá URL.createObjectURL a revoke.

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
  if (node.path && !rootHandle && !uploadedSnapshot && !githubSpec) {
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
  if (rootHandle || uploadedSnapshot || githubSpec) return null;
  return encodeURI(node.path);
}

// --- lazy fetch obsahu file uzlů --------------------------------------------
// tree.json drží jen strukturu + metadata (title, slug). Tělo souborů se
// fetchne přes node.path až při otevření panelu. Cache po prvním fetchi.

const _contentFetches = new Map(); // path → Promise

function nodeNeedsLazyContent(node) {
  if (!node || node.type !== 'file') return false;
  if (node.kind === 'web') return false; // web uzly renderuje iframe přes path
  if (!node.path) return false;
  // potřebujeme fetch dokud nemáme originál v paměti, i kdyby uzel měl
  // override z localStorage (originál slouží jako baseline pro reset).
  return node._originalRaw == null;
}

async function ensureNodeContent(node) {
  if (!nodeNeedsLazyContent(node)) return;
  const path = node.path;
  if (_contentFetches.has(path)) return _contentFetches.get(path);
  const p = (async () => {
    try {
      const res = await fetch(encodeURI(path), { cache: 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
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
      console.warn('lazy fetch failed', path, e);
      _contentFetches.delete(path); // dovol retry při dalším otevření
      throw e;
    }
  })();
  _contentFetches.set(path, p);
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
  renderPanelFoot(panel);
}

function revokePanelUrls(panel) {
  if (!panel || !panel.objectUrls) return;
  for (const u of panel.objectUrls) {
    try { URL.revokeObjectURL(u); } catch {}
  }
  panel.objectUrls.length = 0;
}

// --- media mount (audio / video / image / pdf) ------------------------------
// Volá se po každém renderedBody. Pokud existuje placeholder s [data-media-mount],
// vyřeší URL (path nebo blob z handle/file) a nahradí ho odpovídajícím tagem.

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

// --- panel footer (info o souboru + download odkaz) -------------------------

function humanSize(bytes) {
  if (bytes == null || !isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function nodeKindLabel(node) {
  if (!node) return '';
  if (node.type === 'root') return 'kořen mindmapy';
  if (node.type === 'dir') {
    const n = (node.children || []).length;
    return n ? `adresář · ${n} položek` : 'prázdný adresář';
  }
  const mk = mediaKind(node);
  if (mk === 'video') return 'video';
  if (mk === 'audio') return 'audio';
  if (mk === 'image') return 'obrázek';
  if (mk === 'pdf') return 'PDF';
  if (node.kind === 'web') return 'web snapshot';
  if (node.kind === 'md') return 'markdown';
  if (node.kind === 'text') return 'text';
  return fileExt(node).replace('.', '') || 'soubor';
}

function knownSize(node) {
  if (!node) return null;
  if (node._file && typeof node._file.size === 'number') return node._file.size;
  // text v raw — počet bytů přes Blob (rychlejší a přesnější než TextEncoder)
  if (typeof node.raw === 'string') return new Blob([node.raw]).size;
  if (typeof node.content === 'string') return new Blob([node.content]).size;
  return null;
}

async function renderPanelFoot(panel) {
  if (!panel || !panel.element || !panel.element.isConnected) return;
  const foot = panel.element.querySelector('[data-panel-foot]');
  if (!foot) return;
  const node = panel.node;
  const kindLabel = nodeKindLabel(node);
  // adresář/root → jen info, žádný download
  if (!node || node.type !== 'file') {
    foot.innerHTML = `<span class="panel__foot-info">${escapeHtml(kindLabel)}</span>`;
    return;
  }
  const filename = node.filename || node.name || 'soubor';
  const sz = knownSize(node);
  const sizeStr = sz != null ? humanSize(sz) : '';
  const infoBits = [kindLabel, sizeStr].filter(Boolean).join(' · ');

  // URL pro stažení: přímá (statický deploy / web snapshot) nebo blob
  let url = nodeDirectUrl(node);
  let isBlob = false;
  if (!url) {
    try {
      const blob = await nodeFileBlob(node);
      if (blob) {
        url = URL.createObjectURL(blob);
        panel.objectUrls.push(url);
        isBlob = true;
      }
    } catch {}
  }
  if (!foot.isConnected) return;
  if (!url) {
    foot.innerHTML = `<span class="panel__foot-info">${escapeHtml(infoBits)}</span>`;
    return;
  }
  // single descriptive link = info o souboru + download/share v jednom
  // (target=_blank na blob URL: prohlížeč nabídne uložení / náhled)
  const dlAttr = isBlob ? ` download="${escapeHtml(filename)}"` : ` download="${escapeHtml(filename)}"`;
  foot.innerHTML = `
    <a class="panel__foot-link" href="${url}"${dlAttr} target="_blank" rel="noopener" title="Stáhnout / sdílet">
      <span class="panel__foot-link-name">${escapeHtml(filename)}</span>
      ${infoBits ? `<span class="panel__foot-link-meta">${escapeHtml(infoBits)}</span>` : ''}
      <span class="panel__foot-link-act" aria-hidden="true">↓</span>
    </a>
  `;
}

function bringToFront(el) {
  panelZ++;
  el.style.zIndex = String(panelZ);
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
    <footer class="panel__foot" data-panel-foot></footer>
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

const PANEL_CASCADE = 28; // offset dalšího panelu od poslední pozice

function positionPanel(panel) {
  const el = panel.element;
  if (lastPanelPos) {
    el.style.left = `${lastPanelPos.left + PANEL_CASCADE}px`;
    el.style.top = `${lastPanelPos.top + PANEL_CASCADE}px`;
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
  lastPanelPos = { left: rect.left, top: rect.top };
}

// --- editor mount / persist -------------------------------------------------

function editKey(node) { return LS_EDIT_PREFIX + (node.path || ''); }

function loadEditOverride(node) {
  try { return localStorage.getItem(editKey(node)); } catch { return null; }
}

function saveEditOverride(node, text) {
  try {
    const original = node._originalRaw != null ? node._originalRaw : (node.raw != null ? node.raw : (node.content || ''));
    if (text === original) localStorage.removeItem(editKey(node));
    else localStorage.setItem(editKey(node), text);
  } catch {}
}

function applyEditToNode(node, text) {
  // _originalRaw nastavujeme jen pokud už máme originál v paměti.
  // Pro lazy uzly originál dorazí později (ensureNodeContent) — nepřepisujeme
  // ho prázdným řetězcem, aby reset (`u` v editoru) fungoval správně.
  if (node._originalRaw == null && (node.raw != null || node.content != null)) {
    node._originalRaw = node.raw != null ? node.raw : (node.content || '');
  }
  node.raw = text;
  if (node.kind === 'md') node.content = text;
}

// načte uložené edits z localStorage a aplikuje je na in-memory tree.
function loadAllEditOverrides(nodes) {
  for (const n of nodes) {
    if (!n.path || n.type === 'dir' || n.type === 'root') continue;
    const saved = loadEditOverride(n);
    if (saved != null) applyEditToNode(n, saved);
  }
}

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
  // dej editoru focus, aby vim klávesy fungovaly hned
  requestAnimationFrame(() => handle.focus());
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
  renderPanelFoot(panel);
  closeBtn.addEventListener('click', () => closePanel(panel));

  // lazy fetch obsahu (statický deploy) — po doručení re-renderuje body
  if (nodeNeedsLazyContent(panel.node)) {
    ensureNodeContent(panel.node)
      .then(() => { rerenderPanelBody(panel); renderPanelFoot(panel); })
      .catch(() => {});
  }

  // klikatelné uzly v ASCII stromu (jen u dir-panelu, ale handler je univerzální)
  let pendingTreeSingle = null;
  const handleTreeNode = (e, mode) => {
    const span = e.target.closest('.src-tree .n');
    if (!span) return;
    const raw = span.dataset.path;
    if (raw == null) return;
    const path = raw === '/' ? '' : raw;
    const node = byPath.get(path);
    if (!node) return;
    e.preventDefault();
    e.stopPropagation();
    // adresář (i root) = recenter, panel se stromem nech, ať si user zavře sám
    if (node.type === 'dir' || node.type === 'root') {
      if (pendingTreeSingle) { clearTimeout(pendingTreeSingle); pendingTreeSingle = null; }
      recenter(node.path || '');
      return;
    }
    if (e.shiftKey) { openMainOnly(node); return; }
    if (e.metaKey || e.ctrlKey) { openAsFollower(node); return; }
    if (mode === 'new') {
      if (pendingTreeSingle) { clearTimeout(pendingTreeSingle); pendingTreeSingle = null; }
      openPreview(node);
      return;
    }
    if (pendingTreeSingle) clearTimeout(pendingTreeSingle);
    pendingTreeSingle = setTimeout(() => { pendingTreeSingle = null; openMain(node); }, 220);
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
      renderPanelFoot(panel);
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

function toggleMax(panel) {
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

function closeAllPreviews() {
  for (const p of Array.from(previewPanels.values())) closePanel(p);
}

// Shift varianta: zavři všechny preview, otevři jen main (= jediné okno).
function openMainOnly(node) {
  closeAllPreviews();
  openMain(node);
}

function openMain(node) {
  if (mainPanel) {
    if (mainPanel === activePanel) activePanel = null;
    mainPanel.element.remove();
    mainPanel = null;
  }
  const panel = createPanel(node, 'main');
  positionPanel(panel);
  document.getElementById('panels').appendChild(panel.element);
  setupPanelInteractions(panel);
  bringToFront(panel.element);
  mainPanel = panel;
  if (panelNavListener) panelNavListener();
  setActive(panel);
  refreshOpenLabels();
  return panel;
}

function openPreview(node) {
  const path = node.path || '/';
  const existing = previewPanels.get(path);
  if (existing) {
    bringToFront(existing.element);
    setActive(existing);
    return existing;
  }
  const panel = createPanel(node, 'preview');
  positionPanel(panel);
  document.getElementById('panels').appendChild(panel.element);
  setupPanelInteractions(panel);
  bringToFront(panel.element);
  previewPanels.set(path, panel);
  if (panelNavListener) panelNavListener();
  setActive(panel);
  refreshOpenLabels();
  return panel;
}

// preview, který sleduje focus (otevřený mezerníkem, měněný šipkami)
function openAsFollower(node) {
  const path = node.path || '/';

  // už je follower na tomhle uzlu? jen do popředí
  if (followerPanel && followerPanel.path === path) {
    bringToFront(followerPanel.element);
    setActive(followerPanel);
    return;
  }

  // zavři předchozího followera a zapamatuj si jeho pozici/velikost
  if (followerPanel) {
    const el = followerPanel.element;
    lastFollowerStyles = {
      left: el.style.left, top: el.style.top,
      right: el.style.right, bottom: el.style.bottom,
      width: el.style.width, height: el.style.height,
    };
    closePanel(followerPanel);
  }

  // pokud je uzel už otevřený jako běžný preview, povýším ho na followera
  const existing = previewPanels.get(path);
  if (existing) {
    followerPanel = existing;
    bringToFront(existing.element);
    setActive(existing);
    return;
  }

  // jinak vyrobím nový preview a označím jako follower
  const panel = createPanel(node, 'preview');
  if (lastFollowerStyles) {
    const s = lastFollowerStyles;
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
  previewPanels.set(path, panel);
  followerPanel = panel;
  if (panelNavListener) panelNavListener();
  setActive(panel);
  refreshOpenLabels();
}

function openSiblingFiles(node) {
  if (!node.path || node.type === 'root') return;
  const parts = node.path.split('/');
  const parentPath = parts.slice(0, -1).join('/');
  for (const n of treeNodes) {
    if (n === node) continue;
    if (n.type !== 'file') continue;
    const nParts = (n.path || '').split('/');
    const nParent = nParts.slice(0, -1).join('/');
    if (nParent === parentPath) openPreview(n);
  }
}

function closePanel(panel) {
  destroyEditor(panel);
  revokePanelUrls(panel);
  panel.element.remove();
  if (panel === mainPanel) mainPanel = null;
  else previewPanels.delete(panel.path);
  if (panel === followerPanel) followerPanel = null;
  // poslední zavřené okno = reset kaskády (další otevření zase v rohu)
  if (!mainPanel && previewPanels.size === 0) lastPanelPos = null;
  if (activePanel === panel) {
    activePanel = null;
    // aktivuj nejvyšší zbylý
    const remaining = allPanels();
    if (remaining.length) {
      const top = remaining.reduce((a, b) => (
        Number(a.element.style.zIndex || 0) > Number(b.element.style.zIndex || 0) ? a : b
      ));
      setActive(top);
    }
  }
  if (panelNavListener) panelNavListener();
  refreshOpenLabels();
}

// --- spodní navigace --------------------------------------------------------

function renderNav(grid, vp) {
  const dropdown = document.getElementById('nav-dropdown');
  const tabs = document.getElementById('nav-tabs');
  const homeBtn = document.querySelector('[data-home-btn]');
  const homeWrap = document.querySelector('.nav__home');

  // ~/cesta label + breadcrumb aktuální cesty + historie. Volá se po každém recenter.
  const renderRoute = () => {
    homeBtn.textContent = currentRootPath ? `~/${currentRootPath}/` : '~/';
    homeBtn.title = currentRootPath ? `Skok na hlavní strom (~/)` : 'Hlavní strom';
    dropdown.innerHTML = '';

    // breadcrumb ancestrů — jen když nejsme na home
    const crumbs = [];
    if (currentRootPath) {
      crumbs.push({ path: '', label: '~/' });
      const segs = currentRootPath.split('/');
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
    if (recenterHistory.length) {
      if (crumbs.length) {
        const sep = document.createElement('div');
        sep.className = 'nav__crumb-sep';
        dropdown.appendChild(sep);
      }
      for (const p of recenterHistory) {
        const row = document.createElement('div');
        row.className = 'nav__hist';
        row.innerHTML = `
          <a class="nav__hist-path" href="#" data-hist-path="${escapeHtml(p)}">~/${escapeHtml(p)}/</a>
          <button class="nav__hist-close" type="button" data-hist-close="${escapeHtml(p)}" aria-label="Odstranit z historie">×</button>
        `;
        dropdown.appendChild(row);
      }
    }

    if (!crumbs.length && !recenterHistory.length) dropdown.classList.add('is-empty');
    else dropdown.classList.remove('is-empty');
  };
  renderRoute();
  routeNavListener = renderRoute;

  // taby = všechny otevřené panely
  const renderTabs = () => {
    tabs.innerHTML = '';
    const all = [];
    if (mainPanel) all.push(mainPanel);
    for (const p of previewPanels.values()) all.push(p);
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
      if (p === activePanel) cls += ' is-active';
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
  panelNavListener = renderTabs;

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
      if (mainPanel?.path === path) closePanel(mainPanel);
      else {
        const p = previewPanels.get(path);
        if (p) closePanel(p);
      }
      return;
    }
    const tab = e.target.closest('.nav__tab');
    if (tab) {
      const path = tab.dataset.path;
      const panel = mainPanel?.path === path ? mainPanel : previewPanels.get(path);
      if (panel) { bringToFront(panel.element); setActive(panel); }
    }
  });
}

// --- klávesnice: šipky + Enter ----------------------------------------------

let focusedPath = '';

function focusNode(node) {
  focusedPath = node.path || '';
  // .hit (a11y / pointer target) — beze stylu, jen pro skripty
  document.querySelectorAll('.hit--focus').forEach((el) => el.classList.remove('hit--focus'));
  const hit = document.querySelector(`.hit[data-path="${cssEscapePath(focusedPath || '/')}"]`);
  if (hit) hit.classList.add('hit--focus');
  // vizuální focus = bold žluté písmo v .labels
  document.querySelectorAll('.labels .n--focus').forEach((el) => el.classList.remove('n--focus'));
  const span = document.querySelector(`.labels [data-node-path="${cssEscapePath(focusedPath || '/')}"]`);
  if (span) span.classList.add('n--focus');
}

function refreshOpenLabels() {
  const open = new Set();
  if (mainPanel) open.add(mainPanel.path);
  for (const p of previewPanels.values()) open.add(p.path);
  document.querySelectorAll('.labels .n--open').forEach((el) => el.classList.remove('n--open'));
  for (const path of open) {
    const span = document.querySelector(`.labels [data-node-path="${cssEscapePath(path)}"]`);
    if (span) span.classList.add('n--open');
  }
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

function switchToPanel(panel) {
  if (!panel) return;
  bringToFront(panel.element);
  setActive(panel);
}

function cycleTab(direction) {
  const all = allPanels();
  if (!all.length) return;
  const idx = activePanel ? all.indexOf(activePanel) : -1;
  let n = (idx < 0 ? 0 : idx + direction);
  if (n < 0) n = all.length - 1;
  if (n >= all.length) n = 0;
  switchToPanel(all[n]);
}

function setupKeyboard(_unused, vp) {
  // tree index je module-level (byPath, childrenByPath, topQuadrant);
  // aktualizuje ho buildTreeIndex() volaný z bootu i z rebuildMindmap.

  const move = (current, action) => {
    if (action === 'parent') {
      const parts = (current.path || '').split('/');
      const parentPath = parts.slice(0, -1).join('/');
      // pokud rodič je nad současným virtuálním rootem, vrať virtuální root
      if (currentRootPath && parentPath.length < currentRootPath.length) {
        return byPath.get(currentRootPath);
      }
      return byPath.get(parentPath);
    }
    if (action === 'child') {
      const kids = childrenByPath.get(current.path || '') || [];
      return kids[0];
    }
    if (action === 'prevSibling' || action === 'nextSibling') {
      if (current.type === 'root') return null;
      const parts = current.path.split('/');
      const parentPath = parts.slice(0, -1).join('/');
      let sibs = childrenByPath.get(parentPath) || [];
      // top-level děti (rodič = currentRootPath): omezit na stejný kvadrant
      if (parentPath === currentRootPath) {
        const q = current.quadrant;
        sibs = sibs.filter((s) => topQuadrant.get(s.path) === q);
      }
      const i = sibs.indexOf(current);
      if (i < 0) return null;
      const j = action === 'prevSibling' ? i - 1 : i + 1;
      return sibs[j];
    }
    return null;
  };

  const rootQuadrantArrow = { up: 'north', down: 'south', left: 'west', right: 'east' };
  const goToQuadrant = (q) => {
    const topLevels = childrenByPath.get(currentRootPath) || [];
    return topLevels.find((n) => topQuadrant.get(n.path) === q);
  };

  // pro běžný uzel: šipka → action podle kvadrantu (parent leží vždy směrem k rootu)
  const QUAD_ACTIONS = {
    south: { up: 'parent', down: 'child', left: 'prevSibling', right: 'nextSibling' },
    north: { down: 'parent', up: 'child', left: 'prevSibling', right: 'nextSibling' },
    east:  { left: 'parent', right: 'child', up: 'prevSibling', down: 'nextSibling' },
    west:  { right: 'parent', left: 'child', up: 'prevSibling', down: 'nextSibling' },
  };

  window.addEventListener('keydown', (e) => {
    // pokud uživatel píše do inputu / contenteditable / vim editoru, klávesy nepřebíráme
    const tgt = e.target;
    const tag = tgt && tgt.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (tgt && tgt.isContentEditable)) return;
    if (tgt && tgt.closest && tgt.closest('.vim')) return;

    // Mac: Cmd+Shift+*, Win: Ctrl+Shift+* — okenní zkratky
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.shiftKey) {
      if (e.code === 'KeyW') {
        e.preventDefault();
        if (activePanel) closePanel(activePanel);
        return;
      }
      if (e.code === 'BracketRight') { e.preventDefault(); cycleTab(1); return; }
      if (e.code === 'BracketLeft')  { e.preventDefault(); cycleTab(-1); return; }
      if (e.code === 'KeyM') {
        e.preventDefault();
        if (activePanel) toggleMax(activePanel);
        return;
      }
      if (e.code === 'KeyN') {
        e.preventDefault();
        const node = byPath.get(focusedPath);
        if (node) openPreview(node);
        return;
      }
      const dm = e.code.match(/^Digit([1-9])$/);
      if (dm) {
        e.preventDefault();
        const all = allPanels();
        switchToPanel(all[Number(dm[1]) - 1]);
        return;
      }
      // jiné mod+shift kombinace propustíme prohlížeči
    }

    if (e.key === '0') { vp.center(); return; }

    const dirMap = {
      ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
      k: 'up', j: 'down', h: 'left', l: 'right',
    };
    if (e.key in dirMap) {
      e.preventDefault();
      const dir = dirMap[e.key];
      const current = byPath.get(focusedPath) || byPath.get('');
      if (!current) return;
      let next = null;
      if (current.type === 'root') {
        next = goToQuadrant(rootQuadrantArrow[dir]);
      } else {
        const action = QUAD_ACTIONS[current.quadrant]?.[dir];
        if (action) next = move(current, action);
      }
      // fallback: když strom-akce nic nevrátí (list, konec sourozenců),
      // zkus geometricky nejbližší uzel — aby šipka nezůstávala "zaseklá".
      if (!next) next = findNeighbor(current, dir, treeNodes);
      if (next) {
        focusNode(next);
        vp.ensureVisible(next);
        // pokud běží follower náhled, posuň ho na nový focus
        if (followerPanel) openAsFollower(next);
      }
      return;
    }

    if (e.key === 'Enter') {
      const node = byPath.get(focusedPath);
      if (!node) return;
      e.preventDefault();
      // adresář (i root) = recenter
      if (node.type === 'dir' || node.type === 'root') {
        recenter(node.path || '');
        return;
      }
      // Shift+Enter na souboru = jediné okno (zavři preview, otevři main)
      if (e.shiftKey) {
        openMainOnly(node);
        return;
      }
      // bez modifieru: otevři vždy v novém okně (preview-styled, additive)
      openPreview(node);
      return;
    }

    if (e.key === ' ') {
      const node = byPath.get(focusedPath);
      if (node) {
        e.preventDefault();
        // adresář (i root) = recenter
        if (node.type === 'dir' || node.type === 'root') {
          recenter(node.path || '');
          return;
        }
        // druhý mezerník na stejném uzlu zavře follower
        if (followerPanel && followerPanel.path === (node.path || '/')) {
          closePanel(followerPanel);
        } else {
          openAsFollower(node);
        }
      }
      return;
    }

    if (e.key === 'Escape') {
      // zavře nejvyšší preview, pokud existuje, jinak main
      const lastPreview = Array.from(previewPanels.values()).pop();
      if (lastPreview) closePanel(lastPreview);
      else if (mainPanel) closePanel(mainPanel);
    }
  });
}

// --- FS Access API: walk dropnuté / vybrané složky ---------------------------
// Funguje v Chromu / Edge / Brave. Safari + Firefox zatím FS Access API nemají.

const TEXT_EXTENSIONS = new Set([
  // text & dokumenty
  '.md', '.markdown', '.txt', '.rst', '.adoc', '.tex', '.org',
  // web
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte',
  // data & config
  '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.xml',
  '.csv', '.tsv', '.ini', '.conf', '.env', '.lock',
  // skripty & shell
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  // programovací jazyky
  '.py', '.rb', '.erb', '.rake', '.gemspec', '.ru',
  '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.clj',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.m', '.mm',
  '.swift', '.php', '.pl', '.lua', '.r', '.jl', '.ex', '.exs',
  '.dart', '.zig', '.nim', '.cr', '.hs', '.ml', '.fs',
  // SQL
  '.sql', '.psql',
  // pseudo-binární ale text-friendly
  '.svg', '.log', '.diff', '.patch',
]);

// Soubory bez tečky/přípony, které jsou ve skutečnosti textové.
const TEXT_FILENAMES = new Set([
  'Gemfile', 'Rakefile', 'Capfile', 'Guardfile', 'Procfile',
  'Dockerfile', 'Makefile', 'Containerfile',
  'README', 'LICENSE', 'CHANGELOG', 'AUTHORS', 'CONTRIBUTORS',
  'TODO', 'NOTICE', 'COPYING', 'INSTALL', 'VERSION',
]);

function isTextFile(name, ext) {
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (TEXT_FILENAMES.has(name)) return true;
  // dotfiles (.gitignore, .env.local, .editorconfig) — bez mezery, žádný binární typ
  if (name.startsWith('.') && !name.includes(' ')) return true;
  return false;
}

const FALLBACK_PATTERNS = [
  { pat: '.*', neg: false },
  { pat: '__pycache__', neg: false },
  { pat: 'node_modules', neg: false },
  { pat: 'vendor', neg: false },
  { pat: 'tmp', neg: false },
  { pat: 'log', neg: false },
  { pat: 'coverage', neg: false },
  { pat: 'dist', neg: false },
  { pat: 'build', neg: false },
  { pat: 'target', neg: false },
];

function loadFokrcPatterns(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const neg = t.startsWith('!');
    out.push({ pat: neg ? t.slice(1).trim() : t, neg });
  }
  return out.length ? out : FALLBACK_PATTERNS;
}

function globToRegex(pat) {
  let s = '^';
  for (const ch of pat) {
    if (ch === '*') s += '.*';
    else if (ch === '?') s += '.';
    else if (/[.+^${}()|[\]\\]/.test(ch)) s += '\\' + ch;
    else s += ch;
  }
  return new RegExp(s + '$');
}

function isHidden(name, patterns) {
  let hidden = false;
  for (const { pat, neg } of patterns) {
    if (globToRegex(pat).test(name)) hidden = !neg;
  }
  return hidden;
}

// --- .gitignore parser ------------------------------------------------------
// Podmnožina gitignore: # komentář, ! negace, koncové / = jen dir,
// úvodní / nebo / uprostřed = anchored k umístění .gitignore,
// * = [^/]*, ** = .* (cross-dir), ? = [^/]. Bez character classes a escape.

function parseGitignoreLine(line) {
  let pat = line.replace(/\r$/, '').replace(/\s+$/, '');
  if (!pat || pat.startsWith('#')) return null;
  let negate = false;
  if (pat.startsWith('!')) { negate = true; pat = pat.slice(1); }
  let dirOnly = false;
  if (pat.endsWith('/')) { dirOnly = true; pat = pat.slice(0, -1); }
  if (!pat) return null;
  let anchored = false;
  if (pat.startsWith('/')) { anchored = true; pat = pat.slice(1); }
  else if (pat.includes('/') && !pat.startsWith('**/')) anchored = true;

  let re = '';
  let i = 0;
  while (i < pat.length) {
    const c = pat[i];
    if (c === '*') {
      if (pat[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (pat[i] === '/') { re += '/?'; i++; }
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '/') {
      re += '/';
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }

  const prefix = anchored ? '^' : '(^|/)';
  const suffix = '($|/)';
  return { negate, dirOnly, regex: new RegExp(prefix + re + suffix) };
}

function parseGitignore(text) {
  const rules = [];
  for (const line of text.split('\n')) {
    const r = parseGitignoreLine(line);
    if (r) rules.push(r);
  }
  return rules;
}

// `entries` = pole { path, text }, path = cesta k .gitignore relativní
// k rootu zdroje (bez root segmentu). Vrací list seřazený podle hloubky.
function buildGitignoreIndex(entries) {
  const out = [];
  for (const { path, text } of entries) {
    const dirPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    out.push({ dirPath, rules: parseGitignore(text) });
  }
  out.sort((a, b) =>
    (a.dirPath === '' ? 0 : a.dirPath.split('/').length) -
    (b.dirPath === '' ? 0 : b.dirPath.split('/').length)
  );
  return out;
}

// Aplikuje pravidla od kořene k listům; hlubší .gitignore přepisuje povrchnější.
function isGitignored(path, isDir, gitignores) {
  let decision = false;
  for (const gi of gitignores) {
    if (gi.dirPath !== '' && path !== gi.dirPath && !path.startsWith(gi.dirPath + '/')) continue;
    const rel = gi.dirPath === '' ? path : path.slice(gi.dirPath.length + 1);
    if (!rel) continue;
    for (const rule of gi.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.regex.test(rel)) decision = !rule.negate;
    }
  }
  return decision;
}

function splitExt(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return [name, ''];
  return [name.slice(0, i), name.slice(i).toLowerCase()];
}

function parseFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!m) return [{}, text];
  const fm = {};
  for (const line of m[1].split('\n')) {
    const t = line.trim();
    if (!t || !t.includes(':')) continue;
    const idx = t.indexOf(':');
    const key = t.slice(0, idx).trim();
    let val = t.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[key] = val;
  }
  return [fm, m[2].replace(/^\n+/, '')];
}

async function makeFileNode(handle) {
  const name = handle.name;
  const [stem, ext] = splitExt(name);
  const isMd = ext === '.md';
  const isText = isTextFile(name, ext);
  const node = {
    name,
    type: 'file',
    kind: isMd ? 'md' : (isText ? 'text' : 'other'),
    filename: name,
    _handle: handle,
  };
  if (isText) {
    let text = '';
    try { text = await (await handle.getFile()).text(); } catch {}
    if (isMd) {
      const [fm, body] = parseFrontmatter(text);
      node.slug = fm.slug || stem;
      node.title = fm.title || '';
      node.content = body;
      node.raw = text;
    } else {
      node.content = text;
      node.raw = text;
    }
  }
  return node;
}

async function walkHandle(dirHandle, patterns, gitignores = [], currentPath = '', depth = 0, maxDepth = 4) {
  const node = { name: dirHandle.name, type: 'dir', children: [], _handle: dirHandle };
  if (depth >= maxDepth) return node;
  const entries = [];
  for await (const [name, h] of dirHandle.entries()) entries.push([name, h]);

  // .gitignore v aktuálním adresáři rozšiří stack pro tento podstrom
  let localGitignores = gitignores;
  const giEntry = entries.find(([n, h]) => n === '.gitignore' && h.kind === 'file');
  if (giEntry) {
    try {
      const text = await (await giEntry[1].getFile()).text();
      localGitignores = gitignores.concat([{ dirPath: currentPath, rules: parseGitignore(text) }]);
    } catch {}
  }

  entries.sort(([an, ah], [bn, bh]) => {
    const aIsFile = ah.kind === 'file' ? 1 : 0;
    const bIsFile = bh.kind === 'file' ? 1 : 0;
    if (aIsFile !== bIsFile) return aIsFile - bIsFile;
    return an.toLowerCase().localeCompare(bn.toLowerCase());
  });
  for (const [name, h] of entries) {
    if (isHidden(name, patterns)) continue;
    const childPath = currentPath ? `${currentPath}/${name}` : name;
    const isDir = h.kind === 'directory';
    if (isGitignored(childPath, isDir, localGitignores)) continue;
    if (isDir) {
      node.children.push(await walkHandle(h, patterns, localGitignores, childPath, depth + 1, maxDepth));
    } else {
      node.children.push(await makeFileNode(h));
    }
  }
  return node;
}

async function loadFromHandle(handle) {
  let patterns = FALLBACK_PATTERNS;
  try {
    const fokrc = await handle.getFileHandle('.fokrc');
    patterns = loadFokrcPatterns(await (await fokrc.getFile()).text());
  } catch {}
  const tree = await walkHandle(handle, patterns, [], '', 0);
  tree.name = handle.name || '~';
  return tree;
}

// --- Upload fallback: postav tree z File[] (Safari / Firefox bez FS Access) --
// Soubory přicházejí z <input type=file webkitdirectory> nebo z dataTransfer.files.
// `file.webkitRelativePath` = "<root>/sub/dir/name.ext" (první segment = root jméno).
// Read-only snapshot — žádný `_handle`, edits jdou do localStorage overlay.

async function loadFromFiles(files) {
  const arr = Array.from(files).filter((f) => f && f.webkitRelativePath);
  if (!arr.length) throw new Error('Žádné soubory s relativní cestou.');

  const rootName = arr[0].webkitRelativePath.split('/')[0] || '~';

  // .fokrc — pokud existuje v rootu, použij jeho patterns
  let patterns = FALLBACK_PATTERNS;
  const fokrc = arr.find((f) => f.webkitRelativePath === `${rootName}/.fokrc`);
  if (fokrc) {
    try { patterns = loadFokrcPatterns(await fokrc.text()); } catch {}
  }

  // posbírat všechny .gitignore napříč zdrojem (vnořené i root)
  const giFiles = arr.filter((f) => {
    const rel = f.webkitRelativePath.split('/').slice(1).join('/');
    return rel === '.gitignore' || rel.endsWith('/.gitignore');
  });
  const giEntries = [];
  for (const f of giFiles) {
    try {
      const rel = f.webkitRelativePath.split('/').slice(1).join('/');
      giEntries.push({ path: rel, text: await f.text() });
    } catch {}
  }
  const gitignores = buildGitignoreIndex(giEntries);

  const root = { name: rootName, type: 'dir', children: [] };
  const dirIndex = new Map([['', root]]);
  const ensureDir = (dirPath) => {
    if (dirIndex.has(dirPath)) return dirIndex.get(dirPath);
    const parts = dirPath.split('/');
    const name = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join('/');
    const parent = ensureDir(parentPath);
    if (!parent) return null;
    if (isHidden(name, patterns)) return null;
    if (isGitignored(dirPath, true, gitignores)) return null;
    const node = { name, type: 'dir', children: [] };
    parent.children.push(node);
    dirIndex.set(dirPath, node);
    return node;
  };

  const MAX_DEPTH = 4;
  const filePromises = [];
  for (const file of arr) {
    const rel = file.webkitRelativePath.split('/').slice(1); // bez root segmentu
    if (!rel.length) continue;
    const name = rel[rel.length - 1];
    const dirSegs = rel.slice(0, -1);
    if (dirSegs.length + 1 > MAX_DEPTH) continue;
    if (rel.some((s) => isHidden(s, patterns))) continue;
    if (isGitignored(rel.join('/'), false, gitignores)) continue;
    const parent = ensureDir(dirSegs.join('/'));
    if (!parent) continue;
    const [stem, ext] = splitExt(name);
    const isMd = ext === '.md';
    const isText = isTextFile(name, ext);
    const node = {
      name, type: 'file',
      kind: isMd ? 'md' : (isText ? 'text' : 'other'),
      filename: name,
    };
    // binární média (audio/video/image/pdf) — drž referenci na File pro blob URL
    if (!isText && mediaKind(node)) node._file = file;
    parent.children.push(node);
    if (isText) {
      filePromises.push(async () => {
        try {
          const text = await file.text();
          if (isMd) {
            const [fm, body] = parseFrontmatter(text);
            node.slug = fm.slug || stem;
            node.title = fm.title || '';
            node.content = body;
            node.raw = text;
          } else {
            node.content = text;
            node.raw = text;
          }
        } catch (err) { console.warn('upload read failed', file.webkitRelativePath, err); }
      });
    }
  }

  // sort: dirs nahoru, soubory dolů, abecedně
  const sortChildren = (n) => {
    if (!n.children) return;
    n.children.sort((a, b) => {
      const af = a.type === 'file' ? 1 : 0;
      const bf = b.type === 'file' ? 1 : 0;
      if (af !== bf) return af - bf;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    for (const c of n.children) sortChildren(c);
  };
  sortChildren(root);

  await pLimitAll(filePromises, 16);
  return root;
}

// --- IndexedDB persist: FileSystemDirectoryHandle ---------------------------
// Chrome / Edge dovolí persist FSA handle. Po reloadu queryPermission() typicky
// vrátí 'prompt' → uživatel musí re-grantnout přes user gesture (jedním klikem).

const IDB_NAME = 'fakan';
const IDB_STORE = 'handles';
const IDB_KEY = 'rootHandle';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSetHandle(handle) {
  try {
    const db = await idbOpen();
    await new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  } catch (e) { console.warn('idb persist failed', e); }
}

async function idbGetHandle() {
  try {
    const db = await idbOpen();
    const handle = await new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    db.close();
    return handle || null;
  } catch (e) { return null; }
}

async function idbClearHandle() {
  try {
    const db = await idbOpen();
    await new Promise((res) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(IDB_KEY);
      tx.oncomplete = res;
    });
    db.close();
  } catch {}
}

const IDB_KEY_SNAPSHOT = 'uploadedSnapshot';

async function idbSetSnapshot(tree) {
  try {
    const db = await idbOpen();
    await new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(tree, IDB_KEY_SNAPSHOT);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  } catch (e) { console.warn('idb snapshot persist failed', e); }
}

async function idbGetSnapshot() {
  try {
    const db = await idbOpen();
    const tree = await new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY_SNAPSHOT);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    db.close();
    return tree || null;
  } catch { return null; }
}

async function idbClearSnapshot() {
  try {
    const db = await idbOpen();
    await new Promise((res) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(IDB_KEY_SNAPSHOT);
      tx.oncomplete = res;
    });
    db.close();
  } catch {}
}

const IDB_KEY_GH = 'githubSpec';

async function idbSetGithubSpec(spec) {
  try {
    const db = await idbOpen();
    await new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(spec, IDB_KEY_GH);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  } catch (e) { console.warn('idb gh persist failed', e); }
}

async function idbGetGithubSpec() {
  try {
    const db = await idbOpen();
    const spec = await new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY_GH);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    db.close();
    return spec || null;
  } catch { return null; }
}

async function idbClearGithubSpec() {
  try {
    const db = await idbOpen();
    await new Promise((res) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(IDB_KEY_GH);
      tx.oncomplete = res;
    });
    db.close();
  } catch {}
}

// --- historie zdrojů --------------------------------------------------------
// Pole posledních N připojených zdrojů. Po přepnutí kliku ze source menu
// uživatel skočí na předchozí zdroj. Persistuje se v IDB pod klíčem
// `recentSources`. Položka: { type, label, key, ts, data }.
// - type='handle'   → data=FileSystemDirectoryHandle (structured-cloneable)
// - type='github'   → data=spec { owner, repo, branch, token? }
// - type='snapshot' → bez data (re-mount vyžaduje upload), jen historický záznam

const IDB_KEY_RECENT = 'recentSources';
const RECENT_CAP = 8;

async function idbGetRecent() {
  try {
    const db = await idbOpen();
    const list = await new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY_RECENT);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    db.close();
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

async function idbSetRecent(list) {
  try {
    const db = await idbOpen();
    await new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(list, IDB_KEY_RECENT);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  } catch (e) { console.warn('idb recent persist failed', e); }
}

function recentKey(entry) {
  if (entry.type === 'handle') return `handle:${entry.label}`;
  if (entry.type === 'github') return `github:${entry.data?.owner}/${entry.data?.repo}@${entry.data?.branch || ''}`;
  if (entry.type === 'snapshot') return `snapshot:${entry.label}`;
  return entry.label;
}

async function pushRecentSource(type, label, data) {
  const list = await idbGetRecent();
  const entry = {
    type, label, ts: Date.now(),
    data: type === 'snapshot' ? null : data, // snapshot trees jsou velké → nepersitujeme data
  };
  const key = recentKey(entry);
  const filtered = list.filter((it) => recentKey(it) !== key);
  filtered.unshift(entry);
  await idbSetRecent(filtered.slice(0, RECENT_CAP));
  renderSourceMenu();
}

function currentSourceKey() {
  if (rootHandle) return `handle:${rootHandle.name}`;
  if (githubSpec) return `github:${githubSpec.owner}/${githubSpec.repo}@${githubSpec.branch || ''}`;
  if (uploadedSnapshot) return `snapshot:${uploadedSnapshot.name}`;
  return null;
}

async function reconnectRecent(entry) {
  try {
    if (entry.type === 'github' && entry.data) {
      await connectGithub({ ...entry.data });
      return;
    }
    if (entry.type === 'handle' && entry.data) {
      const handle = entry.data;
      // verify / re-prompt permission (user gesture: klik v dropdownu)
      let perm = 'denied';
      try { perm = await handle.queryPermission({ mode: 'readwrite' }); } catch {}
      if (perm !== 'granted') {
        try { perm = await handle.requestPermission({ mode: 'readwrite' }); } catch {}
      }
      if (perm !== 'granted') {
        alert(`Nelze otevřít „${entry.label}": prohlížeč zamítl přístup.`);
        return;
      }
      await loadAndMount(handle);
      return;
    }
    if (entry.type === 'snapshot') {
      alert(`Snapshot „${entry.label}" je potřeba nahrát znovu (přetáhněte složku do okna).`);
      return;
    }
  } catch (e) {
    console.error('reconnect recent failed', e);
    alert(`Načtení selhalo: ${e.message}`);
  }
}

// --- GitHub jako zdroj ------------------------------------------------------
// Tree přes Git Trees API jedním requestem (recursive=1). Text souborů:
// public přes raw.githubusercontent.com (mimo rate-limit), privátní přes
// /contents s tokenem. Read-only — editor stejně ukládá edits do localStorage
// overlay (saveEditOverride), takže write-back API nepotřebujeme.

function parseRepoInput(raw) {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  const url = t.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?(?:\/tree\/([^/\s?#]+))?\/?(?:[?#].*)?$/);
  if (url) return { owner: url[1], repo: url[2], branch: url[3] || '' };
  const slug = t.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (slug) return { owner: slug[1], repo: slug[2], branch: '' };
  return null;
}

function ghAuthHeaders(spec) {
  return spec.token ? { Authorization: `Bearer ${spec.token}` } : {};
}

async function ghApi(spec, path) {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: { Accept: 'application/vnd.github+json', ...ghAuthHeaders(spec) },
  });
  if (!r.ok) {
    const msg = r.status === 404 ? 'repo nebo větev neexistuje (zkontrolujte owner/repo)'
      : r.status === 401 ? 'token neplatný'
      : r.status === 403 ? 'GitHub odmítl (rate limit nebo přístup)'
      : r.status === 409 ? 'repo je prázdné — žádné commity v default branch'
      : r.status === 422 ? 'GitHub: neplatný požadavek (špatná větev?)'
      : r.status >= 500 ? `GitHub má výpadek (${r.status})`
      : `GitHub ${r.status}`;
    throw new Error(msg);
  }
  return r.json();
}

async function ghFetchText(spec, filePath) {
  const segs = filePath.split('/').map(encodeURIComponent).join('/');
  if (spec.token) {
    const r = await fetch(`https://api.github.com/repos/${spec.owner}/${spec.repo}/contents/${segs}?ref=${encodeURIComponent(spec.branch)}`, {
      headers: { Accept: 'application/vnd.github.raw', ...ghAuthHeaders(spec) },
    });
    if (!r.ok) throw new Error(`gh contents ${r.status}`);
    return r.text();
  }
  const r = await fetch(`https://raw.githubusercontent.com/${spec.owner}/${spec.repo}/${encodeURIComponent(spec.branch)}/${segs}`);
  if (!r.ok) throw new Error(`raw ${r.status}`);
  return r.text();
}

async function ghListBranches(spec) {
  const out = [];
  let page = 1;
  while (page <= 5) {
    const data = await ghApi(spec, `/repos/${spec.owner}/${spec.repo}/branches?per_page=100&page=${page}`);
    if (!Array.isArray(data) || data.length === 0) break;
    for (const b of data) if (b && b.name) out.push(b.name);
    if (data.length < 100) break;
    page++;
  }
  return out;
}

async function pLimitAll(thunks, concurrency = 8) {
  let i = 0;
  const n = thunks.length;
  const workers = Array(Math.min(concurrency, n) || 1).fill(0).map(async () => {
    while (i < n) {
      const idx = i++;
      try { await thunks[idx](); } catch {}
    }
  });
  await Promise.all(workers);
}

async function loadFromGithub(spec, onStatus) {
  const note = (m) => { if (onStatus) onStatus(m); };
  if (!spec.branch) {
    note('zjišťuju default branch…');
    const repo = await ghApi(spec, `/repos/${spec.owner}/${spec.repo}`);
    spec.branch = repo.default_branch || 'main';
  }
  let patterns = FALLBACK_PATTERNS;
  try { patterns = loadFokrcPatterns(await ghFetchText(spec, '.fokrc')); } catch {}

  note('načítám strom…');
  const data = await ghApi(spec, `/repos/${spec.owner}/${spec.repo}/git/trees/${encodeURIComponent(spec.branch)}?recursive=1`);
  if (data.truncated) console.warn('GitHub tree truncated — některé soubory chybí');

  const depthOf = (p) => p === '' ? 0 : p.split('/').length;
  const MAX_DEPTH = 4;

  // posbírej a stáhni všechny .gitignore (root + vnořené, do MAX_DEPTH)
  const giPaths = (data.tree || [])
    .filter((e) => e.type === 'blob' && e.path && depthOf(e.path) <= MAX_DEPTH &&
                   (e.path === '.gitignore' || e.path.endsWith('/.gitignore')))
    .map((e) => e.path);
  const giEntries = [];
  await pLimitAll(giPaths.map((p) => async () => {
    try { giEntries.push({ path: p, text: await ghFetchText(spec, p) }); } catch {}
  }), 8);
  const gitignores = buildGitignoreIndex(giEntries);

  const root = { name: spec.repo, type: 'dir', children: [] };
  const dirIndex = new Map([['', root]]);
  const ensureDir = (dirPath) => {
    if (dirIndex.has(dirPath)) return dirIndex.get(dirPath);
    const parts = dirPath.split('/');
    const name = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join('/');
    const parent = ensureDir(parentPath);
    if (!parent) return null;
    const node = { name, type: 'dir', children: [] };
    parent.children.push(node);
    dirIndex.set(dirPath, node);
    return node;
  };
  const isPathHidden = (p) => p.split('/').some((s) => isHidden(s, patterns));

  const entries = (data.tree || []).slice().sort((a, b) => a.path.localeCompare(b.path));
  const filePromises = [];
  for (const e of entries) {
    if (!e.path) continue;
    if (depthOf(e.path) > MAX_DEPTH) continue;
    if (isPathHidden(e.path)) continue;
    if (isGitignored(e.path, e.type === 'tree', gitignores)) continue;
    if (e.type === 'tree') {
      ensureDir(e.path);
    } else if (e.type === 'blob') {
      const parts = e.path.split('/');
      const name = parts[parts.length - 1];
      const parentPath = parts.slice(0, -1).join('/');
      const parent = ensureDir(parentPath);
      if (!parent) continue;
      const [stem, ext] = splitExt(name);
      const isMd = ext === '.md';
      const isText = isTextFile(name, ext);
      const node = {
        name, type: 'file',
        kind: isMd ? 'md' : (isText ? 'text' : 'other'),
        filename: name,
      };
      parent.children.push(node);
      if (isText) {
        const blobPath = e.path;
        filePromises.push(async () => {
          try {
            const text = await ghFetchText(spec, blobPath);
            if (isMd) {
              const [fm, body] = parseFrontmatter(text);
              node.slug = fm.slug || stem;
              node.title = fm.title || '';
              node.content = body;
              node.raw = text;
            } else {
              node.content = text;
              node.raw = text;
            }
          } catch (err) { console.warn('gh fetch failed', blobPath, err); }
        });
      }
    }
  }

  // pořadí: dirs nahoru, soubory dolů, abecedně — stejné jako walkHandle()
  const sortChildren = (n) => {
    if (!n.children) return;
    n.children.sort((a, b) => {
      const af = a.type === 'file' ? 1 : 0;
      const bf = b.type === 'file' ? 1 : 0;
      if (af !== bf) return af - bf;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    for (const c of n.children) sortChildren(c);
  };
  sortChildren(root);

  note(`stahuji obsah (${filePromises.length})…`);
  await pLimitAll(filePromises, 8);
  return root;
}

// --- zdroj: mount / unmount / restore --------------------------------------

let rootHandle = null;
let githubSpec = null;
let uploadedSnapshot = null;  // { name } — read-only snapshot z file upload

function showEmptyState() {
  const overlay = document.getElementById('empty-state');
  if (overlay) overlay.hidden = false;
}

function hideEmptyState() {
  const overlay = document.getElementById('empty-state');
  if (overlay) overlay.hidden = true;
}

function renderEmptyHint(state) {
  const inner = document.querySelector('[data-empty-hint]');
  if (!inner) return;
  inner.innerHTML = '';
  if (state && state.needsPermission && state.handle) {
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'empty-state__rest';
    restore.textContent = `Otevřít poslední: ${state.handle.name}`;
    restore.addEventListener('click', async () => {
      try {
        const perm = await state.handle.requestPermission({ mode: 'readwrite' });
        if (perm === 'granted') await loadAndMount(state.handle, { persist: false });
        else alert('Bez povolení nemůžu složku otevřít. Pusťte ji sem znovu, nebo zvolte přes Zdroj ▾.');
      } catch (e) { console.error(e); }
    });
    inner.appendChild(restore);
    const note = document.createElement('p');
    note.className = 'empty-state__note';
    note.textContent = 'Nebo pusťte jinou složku sem.';
    inner.appendChild(note);
    return;
  }
  const p = document.createElement('p');
  p.innerHTML = 'Bez zdroje. Pusťte sem složku nebo otevřete přes <kbd>Zdroj</kbd> v menu.';
  inner.appendChild(p);
}

function setupDropZone() {
  const overlay = document.getElementById('empty-state');
  if (!overlay) return;
  const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  const onDragOver = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    overlay.classList.add('is-dragover');
  };
  const onDragLeave = (e) => {
    if (e.relatedTarget == null) overlay.classList.remove('is-dragover');
  };
  const onDrop = async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    overlay.classList.remove('is-dragover');
    const item = e.dataTransfer.items?.[0];
    if (!item) return;
    if (!item.getAsFileSystemHandle) {
      // Safari / Firefox: zkus dataTransfer.files. Drop *složky* sem dá jen
      // 1 položku (samotnou složku, neumíme číst), drop více *souborů* funguje.
      const files = Array.from(e.dataTransfer.files || []).filter((f) => f.webkitRelativePath);
      if (!files.length) {
        alert('Tento prohlížeč drop složky nepodporuje. Použijte „Otevřít složku…" v menu Zdroj.');
        return;
      }
      await loadAndMountSnapshot(files);
      return;
    }
    let handle;
    try { handle = await item.getAsFileSystemHandle(); }
    catch (err) { console.error(err); return; }
    if (handle.kind !== 'directory') {
      alert('Pusťte sem celou složku, ne jeden soubor.');
      return;
    }
    await loadAndMount(handle);
  };
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);
}

async function openDirectoryPicker() {
  if (window.showDirectoryPicker) {
    let handle;
    try {
      handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (e) {
      if (e.name !== 'AbortError') console.error(e);
      return;
    }
    await loadAndMount(handle);
    return;
  }
  // Safari / Firefox fallback: <input type=file webkitdirectory>
  await openUploadPicker();
}

async function openUploadPicker() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.webkitdirectory = true;
  input.style.display = 'none';
  document.body.appendChild(input);
  const files = await new Promise((res) => {
    input.addEventListener('change', () => res(Array.from(input.files || [])), { once: true });
    // bez user gesture by .click() neproletělo; spouští se z onClick menu
    input.click();
  });
  input.remove();
  if (!files.length) return;
  await loadAndMountSnapshot(files);
}

async function loadAndMount(handle, opts = {}) {
  try {
    const tree = await loadFromHandle(handle);
    rootHandle = handle;
    githubSpec = null;
    uploadedSnapshot = null;
    originalTree = tree;
    currentRootPath = '';
    recenterHistory = [];
    hideEmptyState();
    rebuildMindmap('');
    renderSourceMenu();
    if (opts.persist !== false) await idbSetHandle(handle);
    await idbClearGithubSpec();
    await idbClearSnapshot();
    await pushRecentSource('handle', handle.name || '~', handle);
  } catch (err) {
    console.error(err);
    alert(`Načtení složky selhalo: ${err.message}`);
  }
}

async function loadAndMountSnapshot(files, opts = {}) {
  try {
    const tree = opts.tree || await loadFromFiles(files);
    rootHandle = null;
    githubSpec = null;
    uploadedSnapshot = { name: tree.name };
    originalTree = tree;
    currentRootPath = '';
    recenterHistory = [];
    hideEmptyState();
    rebuildMindmap('');
    renderSourceMenu();
    if (opts.persist !== false) await idbSetSnapshot(tree);
    await idbClearHandle();
    await idbClearGithubSpec();
    await pushRecentSource('snapshot', tree.name || 'snapshot', null);
  } catch (err) {
    console.error(err);
    alert(`Nahrání složky selhalo: ${err.message}`);
  }
}

async function connectGithub(spec, onStatus) {
  const tree = await loadFromGithub(spec, onStatus);
  rootHandle = null;
  githubSpec = spec;
  uploadedSnapshot = null;
  originalTree = tree;
  currentRootPath = '';
  recenterHistory = [];
  hideEmptyState();
  rebuildMindmap('');
  renderSourceMenu();
  await idbSetGithubSpec(spec);
  await idbClearHandle();
  await idbClearSnapshot();
  await pushRecentSource('github', `${spec.owner}/${spec.repo}${spec.branch ? `@${spec.branch}` : ''}`, spec);
}

async function disconnectSource() {
  await idbClearHandle();
  await idbClearGithubSpec();
  await idbClearSnapshot();
  rootHandle = null;
  githubSpec = null;
  uploadedSnapshot = null;
  originalTree = null;
  currentRootPath = '';
  recenterHistory = [];
  treeNodes = [];
  currentBbox = null;
  byPath.clear();
  childrenByPath.clear();
  topQuadrant.clear();
  // zavřít všechny panely
  if (mainPanel) closePanel(mainPanel);
  for (const p of Array.from(previewPanels.values())) closePanel(p);
  // smazat render
  const map = document.getElementById('map');
  const labels = document.getElementById('labels');
  const hits = document.getElementById('hits');
  if (map) map.textContent = '';
  if (labels) labels.innerHTML = '';
  if (hits) hits.innerHTML = '';
  if (routeNavListener) routeNavListener();
  renderEmptyHint(null);
  showEmptyState();
  renderSourceMenu();
}

async function tryRestoreSource() {
  const handle = await idbGetHandle();
  if (!handle) return false;
  try {
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      await loadAndMount(handle, { persist: false });
      return true;
    }
    renderEmptyHint({ needsPermission: true, handle });
    return false;
  } catch (e) {
    console.warn('restore source: queryPermission failed', e);
    renderEmptyHint({ needsPermission: true, handle });
    return false;
  }
}

async function tryRestoreGithub() {
  const spec = await idbGetGithubSpec();
  if (!spec || !spec.owner || !spec.repo) return false;
  try {
    await connectGithub({ ...spec });
    return true;
  } catch (e) {
    console.warn('restore github failed', e);
    return false;
  }
}

async function tryRestoreSnapshot() {
  const tree = await idbGetSnapshot();
  if (!tree) return false;
  try {
    await loadAndMountSnapshot(null, { tree, persist: false });
    return true;
  } catch (e) {
    console.warn('restore snapshot failed', e);
    return false;
  }
}

// Default fallback — pokud uživatel nemá žádný zdroj v IDB, načti statický
// tree.json z apex domény. Obsah jednotlivých souborů se lazy fetchne přes path.
async function tryLoadStaticTree() {
  try {
    const res = await fetch('tree.json', { cache: 'no-cache' });
    if (!res.ok) return false;
    const tree = await res.json();
    rootHandle = null;
    githubSpec = null;
    uploadedSnapshot = null;
    originalTree = tree;
    currentRootPath = '';
    recenterHistory = [];
    hideEmptyState();
    rebuildMindmap('');
    return true;
  } catch (e) {
    console.warn('static tree load failed', e);
    return false;
  }
}

// --- GitHub dialog ----------------------------------------------------------

function showGithubDialog() {
  // zavři případnou existující instanci
  document.querySelector('[data-gh-dialog]')?.remove();

  const wrap = document.createElement('div');
  wrap.className = 'gh-dialog';
  wrap.setAttribute('data-gh-dialog', '');
  wrap.innerHTML = `
    <div class="gh-dialog__panel" role="dialog" aria-modal="true" aria-label="Připojit GitHub repo">
      <h2 class="gh-dialog__title">Připojit GitHub repo</h2>
      <label class="gh-dialog__field">
        <span>Repo</span>
        <input type="text" data-gh-repo placeholder="owner/repo nebo https://github.com/owner/repo" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
      </label>
      <label class="gh-dialog__field">
        <span>Větev <em>(volitelně)</em></span>
        <input type="text" data-gh-branch placeholder="default branch" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
      </label>
      <label class="gh-dialog__field">
        <span>Token <em>(volitelně, pro privátní repo)</em></span>
        <input type="password" data-gh-token placeholder="ghp_… / github_pat_…" autocomplete="off" spellcheck="false">
      </label>
      <p class="gh-dialog__hint">Token zůstane jen lokálně v IndexedDB tohohle prohlížeče. Bez tokenu lze připojit jen veřejný repo.</p>
      <div class="gh-dialog__status" data-gh-status></div>
      <div class="gh-dialog__buttons">
        <button type="button" class="gh-dialog__btn" data-gh-cancel>Zrušit</button>
        <button type="button" class="gh-dialog__btn gh-dialog__btn--primary" data-gh-ok>Připojit</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  const repoIn = wrap.querySelector('[data-gh-repo]');
  const branchIn = wrap.querySelector('[data-gh-branch]');
  const tokenIn = wrap.querySelector('[data-gh-token]');
  const okBtn = wrap.querySelector('[data-gh-ok]');
  const cancelBtn = wrap.querySelector('[data-gh-cancel]');
  const statusEl = wrap.querySelector('[data-gh-status]');

  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter' && !okBtn.disabled) { e.preventDefault(); submit(); }
  };
  document.addEventListener('keydown', onKey);
  cancelBtn.addEventListener('click', close);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });

  const submit = async () => {
    const parsed = parseRepoInput(repoIn.value);
    if (!parsed) {
      statusEl.textContent = 'Zadejte owner/repo nebo URL.';
      statusEl.dataset.kind = 'err';
      repoIn.focus();
      return;
    }
    const spec = { ...parsed };
    const br = branchIn.value.trim();
    const tk = tokenIn.value.trim();
    if (br) spec.branch = br;
    if (tk) spec.token = tk;

    okBtn.disabled = true;
    cancelBtn.disabled = true;
    statusEl.dataset.kind = 'info';
    statusEl.textContent = 'Připojuju…';
    try {
      await connectGithub(spec, (m) => { statusEl.textContent = m; });
      close();
    } catch (err) {
      console.error(err);
      statusEl.dataset.kind = 'err';
      statusEl.textContent = `Chyba: ${err.message}`;
      okBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  };
  okBtn.addEventListener('click', submit);
  setTimeout(() => repoIn.focus(), 0);
}

// --- Branch picker ----------------------------------------------------------

function showBranchPicker() {
  if (!githubSpec) return;
  document.querySelector('[data-gh-branch-picker]')?.remove();

  const spec = githubSpec;
  const wrap = document.createElement('div');
  wrap.className = 'gh-dialog';
  wrap.setAttribute('data-gh-branch-picker', '');
  wrap.innerHTML = `
    <div class="gh-dialog__panel" role="dialog" aria-modal="true" aria-label="Přepnout větev">
      <h2 class="gh-dialog__title">Větev v ${escapeHtml(spec.owner)}/${escapeHtml(spec.repo)}</h2>
      <div class="gh-dialog__status" data-gh-status>načítám větve…</div>
      <div class="gh-branches" data-gh-branches hidden></div>
      <div class="gh-dialog__buttons">
        <button type="button" class="gh-dialog__btn" data-gh-cancel>Zavřít</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  const statusEl = wrap.querySelector('[data-gh-status]');
  const listEl = wrap.querySelector('[data-gh-branches]');
  const cancelBtn = wrap.querySelector('[data-gh-cancel]');

  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey);
  cancelBtn.addEventListener('click', close);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });

  const switchTo = async (branch) => {
    if (!githubSpec || branch === githubSpec.branch) { close(); return; }
    statusEl.dataset.kind = 'info';
    statusEl.textContent = `přepínám na ${branch}…`;
    statusEl.hidden = false;
    listEl.hidden = true;
    try {
      await connectGithub({ ...spec, branch }, (m) => { statusEl.textContent = m; });
      close();
    } catch (err) {
      console.error(err);
      statusEl.dataset.kind = 'err';
      statusEl.textContent = `Chyba: ${err.message}`;
      listEl.hidden = false;
    }
  };

  (async () => {
    try {
      const branches = await ghListBranches(spec);
      if (!branches.length) {
        statusEl.dataset.kind = 'err';
        statusEl.textContent = 'Žádné větve.';
        return;
      }
      const cur = spec.branch;
      const ordered = branches.slice().sort((a, b) => {
        if (a === cur) return -1;
        if (b === cur) return 1;
        return a.localeCompare(b);
      });
      listEl.innerHTML = ordered.map((b) => {
        const isCur = b === cur;
        return `<button type="button" class="gh-branch${isCur ? ' gh-branch--current' : ''}" data-branch="${escapeHtml(b)}">
          <span class="gh-branch__name">${escapeHtml(b)}</span>
          ${isCur ? '<span class="gh-branch__tag">aktuální</span>' : ''}
        </button>`;
      }).join('');
      listEl.querySelectorAll('[data-branch]').forEach((btn) => {
        btn.addEventListener('click', () => switchTo(btn.dataset.branch));
      });
      statusEl.hidden = true;
      listEl.hidden = false;
    } catch (err) {
      console.error(err);
      statusEl.dataset.kind = 'err';
      statusEl.textContent = `Chyba: ${err.message}`;
    }
  })();
}

// --- zdrojové menu v navu ---------------------------------------------------

function renderSourceMenu() {
  const label = document.querySelector('[data-source-label]');
  const menu = document.querySelector('[data-source-menu]');
  const labelText = rootHandle ? rootHandle.name
    : githubSpec ? `${githubSpec.owner}/${githubSpec.repo}`
    : uploadedSnapshot ? uploadedSnapshot.name
    : 'Zdroj';
  if (label) label.textContent = labelText;
  if (!menu) return;
  menu.innerHTML = '';

  const hasSource = !!(rootHandle || githubSpec || uploadedSnapshot);
  const items = [];
  items.push({
    label: hasSource ? 'Otevřít jinou složku…' : 'Otevřít složku…',
    onClick: openDirectoryPicker,
  });
  items.push({
    label: githubSpec ? 'Připojit jiný GitHub repo…' : 'Připojit GitHub repo…',
    onClick: showGithubDialog,
  });
  if (githubSpec) {
    items.push({
      label: `Větev: ${githubSpec.branch || '…'} ▾`,
      onClick: showBranchPicker,
    });
  }
  items.push({ label: 'Export…', disabled: true, title: 'Brzy' });
  if (hasSource) {
    items.push({ label: 'Odpojit zdroj', onClick: disconnectSource, danger: true });
  }

  const closeMenu = () => {
    const wrap = document.querySelector('[data-nav-source]');
    wrap?.classList.remove('is-open');
    if (document.activeElement && wrap?.contains(document.activeElement)) document.activeElement.blur();
  };

  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'nav__source-item' + (it.danger ? ' nav__source-item--danger' : '');
    b.textContent = it.label;
    if (it.title) b.title = it.title;
    if (it.disabled) b.disabled = true;
    if (it.onClick) b.addEventListener('click', () => {
      closeMenu();
      it.onClick();
    });
    menu.appendChild(b);
  }

  // historie zdrojů — async, po dohrátí přidá sekci
  idbGetRecent().then((list) => {
    if (!list.length) return;
    const curKey = currentSourceKey();
    const past = list.filter((e) => recentKey(e) !== curKey);
    if (!past.length) return;

    const sep = document.createElement('div');
    sep.className = 'nav__source-sep';
    sep.textContent = 'Nedávné';
    menu.appendChild(sep);

    for (const entry of past) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'nav__source-item nav__source-item--recent';
      const icon = entry.type === 'handle' ? '/' : entry.type === 'github' ? '⎇' : '⤓';
      b.innerHTML = `<span class="nav__source-item-icon" aria-hidden="true">${icon}</span><span class="nav__source-item-label">${escapeHtml(entry.label)}</span>`;
      if (entry.type === 'snapshot') {
        b.title = 'Snapshot — pro otevření nahrajte složku znovu';
        b.classList.add('nav__source-item--dim');
      }
      b.addEventListener('click', () => {
        closeMenu();
        reconnectRecent(entry);
      });
      menu.appendChild(b);
    }

    // možnost vyčistit historii
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'nav__source-item nav__source-item--clear';
    clearBtn.textContent = 'Vyčistit historii';
    clearBtn.addEventListener('click', async () => {
      closeMenu();
      await idbSetRecent([]);
      renderSourceMenu();
    });
    menu.appendChild(clearBtn);
  }).catch(() => {});
}

// --- floating badge + wizard -----------------------------------------------

const STRIPE_TIP_URL = 'https://donate.stripe.com/PLACEHOLDER';
const WAITLIST_ENDPOINT = '/waitlist';
const HOSTED_PRICE_CZK = 99;

const RESERVED_SUBDOMAINS = new Set([
  'www', 'api', 'app', 'auth', 'admin', 'status', 'docs', 'mail',
  'fakan', 'help', 'support', 'blog', 'dev', 'staging', 'test',
  'mx', 'ns', 'ns1', 'ns2', 'smtp', 'pop', 'imap', 'ftp',
  'root', 'webmaster', 'postmaster',
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

function mountBadge() {
  const wrap = document.getElementById('badge');
  if (!wrap) return;
  wrap.innerHTML = `
    <div class="badge__row">
      <button type="button" class="badge__cta badge__cta--want" data-badge-want>Chci tohle taky →</button>
      <button type="button" class="badge__cta badge__cta--tip" data-badge-tip>Přispět</button>
    </div>
    <a class="badge__meta" href="https://github.com/junkycoder/fakan" target="_blank" rel="noopener">Open source · AGPL-3.0</a>
  `;
  wrap.removeAttribute('hidden');
  wrap.querySelector('[data-badge-want]').addEventListener('click', () => showWizard());
  wrap.querySelector('[data-badge-tip]').addEventListener('click', () => {
    window.open(STRIPE_TIP_URL, '_blank', 'noopener');
  });
}

function showWizard() {
  document.querySelector('[data-wizard]')?.remove();

  const state = {
    step: 1,
    email: '',
    consent: false,
    subdomain: '',
    wantsCustomDomain: false,
    sourceType: '',
  };

  const wrap = document.createElement('div');
  wrap.className = 'wizard';
  wrap.setAttribute('data-wizard', '');
  wrap.innerHTML = `
    <div class="wizard__panel" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
      <header class="wizard__head">
        <h2 class="wizard__title" id="wizard-title">Vlastní fakan space</h2>
        <span class="wizard__progress" data-wizard-progress>1 / 5</span>
      </header>

      <section class="wizard__step wizard__step--active" data-step="1">
        <p class="wizard__intro">fakan je „přehrávač kazet". Vy nám dáte složku nebo git repo s vašimi <code>.md</code> soubory, my je servírujeme na <code>vy.fakan.cz</code> jako mindmapu.</p>
        <p class="wizard__intro wizard__intro--muted">Hosted plán bude od ${HOSTED_PRICE_CZK} Kč&nbsp;/&nbsp;měsíc. Backend ještě stavíme — teď sbíráme zájem, dáme vědět, jakmile půjde to nasadit.</p>
      </section>

      <section class="wizard__step" data-step="2">
        <p class="wizard__intro">Kam vám napsat, až to půjde spustit?</p>
        <label class="wizard__field">
          <span>E-mail</span>
          <input type="email" data-wizard-email placeholder="vy@example.com" autocomplete="email" required>
        </label>
        <label class="wizard__check">
          <input type="checkbox" data-wizard-consent>
          <span>Posílejte mi i drobné aktualizace o vývoji. Žádný spam, kdykoli odhlásit.</span>
        </label>
      </section>

      <section class="wizard__step" data-step="3">
        <p class="wizard__intro">Jaká subdoména pod <code>fakan.cz</code>?</p>
        <label class="wizard__field">
          <span>Subdoména</span>
          <span class="wizard__subdomain">
            <input type="text" data-wizard-subdomain placeholder="vase-jmeno" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
            <span class="wizard__subdomain-suffix">.fakan.cz</span>
          </span>
        </label>
        <p class="wizard__hint">Malá písmena, číslice a pomlčky. 2 až 31 znaků. Dostupnost ověříme při spuštění.</p>
        <label class="wizard__check">
          <input type="checkbox" data-wizard-custom>
          <span>Chci místo toho vlastní doménu (nakoupíme&nbsp;přes&nbsp;nás, DNS i TLS řešíme my).</span>
        </label>
      </section>

      <section class="wizard__step" data-step="4">
        <p class="wizard__intro">Odkud bereme obsah?</p>
        <div class="wizard__radios" data-wizard-radios>
          <label class="wizard__radio">
            <input type="radio" name="source" value="github">
            <span>
              <strong>GitHub repo</strong>
              <small>Nejlepší volba. Commit = deploy. Zálohy jednou denně do našeho úložiště.</small>
            </span>
          </label>
          <label class="wizard__radio">
            <input type="radio" name="source" value="folder">
            <span>
              <strong>Lokální složka</strong>
              <small>Z prohlížeče (Chrome/Edge). Synchronizace ručně, bez gitu.</small>
            </span>
          </label>
          <label class="wizard__radio">
            <input type="radio" name="source" value="upload">
            <span>
              <strong>Upload archivu</strong>
              <small>Pošlete zip / složku jednorázově. Edity přes naše UI, pravidelné backupy.</small>
            </span>
          </label>
        </div>
      </section>

      <section class="wizard__step" data-step="5">
        <p class="wizard__intro">Tady je co máme:</p>
        <div class="wizard__summary">
          <dl>
            <div><dt>E-mail</dt><dd data-summary-email></dd></div>
            <div><dt>Adresa</dt><dd data-summary-addr></dd></div>
            <div><dt>Zdroj</dt><dd data-summary-source></dd></div>
          </dl>
        </div>
        <p class="wizard__hint">Po odeslání se vám ozveme e-mailem, jakmile Hosted otevřeme.<br>Mezitím můžete podpořit vývoj přes <strong>Přispět</strong>.</p>
      </section>

      <div class="wizard__error" data-wizard-error></div>

      <div class="wizard__buttons">
        <button type="button" class="wizard__btn" data-wizard-cancel>Zavřít</button>
        <div class="wizard__buttons-right">
          <button type="button" class="wizard__btn" data-wizard-prev hidden>Zpět</button>
          <button type="button" class="wizard__btn wizard__btn--primary" data-wizard-next>Pokračovat</button>
        </div>
      </div>

      <div class="wizard__foot">
        Vaše data zůstávají ve vašem repu nebo složce. Když fakan zanikne, doména i obsah jsou vaše. <a href="#" data-wizard-zaruka>Záruka</a>.
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  const panel = wrap.querySelector('.wizard__panel');
  const progress = wrap.querySelector('[data-wizard-progress]');
  const steps = Array.from(wrap.querySelectorAll('.wizard__step'));
  const errorEl = wrap.querySelector('[data-wizard-error]');
  const cancelBtn = wrap.querySelector('[data-wizard-cancel]');
  const prevBtn = wrap.querySelector('[data-wizard-prev]');
  const nextBtn = wrap.querySelector('[data-wizard-next]');
  const emailIn = wrap.querySelector('[data-wizard-email]');
  const consentIn = wrap.querySelector('[data-wizard-consent]');
  const subIn = wrap.querySelector('[data-wizard-subdomain]');
  const customIn = wrap.querySelector('[data-wizard-custom]');
  const radios = wrap.querySelector('[data-wizard-radios]');
  const TOTAL_STEPS = steps.length;

  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  };
  document.addEventListener('keydown', onKey);
  cancelBtn.addEventListener('click', close);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });

  const setError = (msg) => { errorEl.textContent = msg || ''; };

  const render = () => {
    steps.forEach((s) => s.classList.toggle('wizard__step--active', Number(s.dataset.step) === state.step));
    progress.textContent = `${state.step} / ${TOTAL_STEPS}`;
    prevBtn.hidden = state.step === 1;
    nextBtn.textContent = state.step === TOTAL_STEPS ? 'Zařadit na waitlist' : 'Pokračovat';
    setError('');
    panel.scrollTop = 0;
    // focus pro krok
    setTimeout(() => {
      if (state.step === 2) emailIn.focus();
      else if (state.step === 3) subIn.focus();
      else if (state.step === 5) renderSummary();
    }, 0);
  };

  const renderSummary = () => {
    wrap.querySelector('[data-summary-email]').textContent = state.email || '—';
    const addr = state.wantsCustomDomain ? 'vlastní doména (vybereme společně)' : (state.subdomain ? `${state.subdomain}.fakan.cz` : '—');
    wrap.querySelector('[data-summary-addr]').textContent = addr;
    const sourceLabel = {
      github: 'GitHub repo',
      folder: 'lokální složka',
      upload: 'upload archivu',
    }[state.sourceType] || '—';
    wrap.querySelector('[data-summary-source]').textContent = sourceLabel;
  };

  const validateStep = () => {
    if (state.step === 2) {
      const v = emailIn.value.trim();
      if (!EMAIL_RE.test(v)) { setError('Zkontrolujte, prosím, e-mail.'); emailIn.focus(); return false; }
      state.email = v;
      state.consent = !!consentIn.checked;
      return true;
    }
    if (state.step === 3) {
      state.wantsCustomDomain = !!customIn.checked;
      if (state.wantsCustomDomain) {
        state.subdomain = '';
        return true;
      }
      const v = subIn.value.trim().toLowerCase();
      if (!SUBDOMAIN_RE.test(v)) { setError('Subdoména: 2 až 31 znaků, malá písmena, číslice, pomlčky. Nesmí začínat pomlčkou.'); subIn.focus(); return false; }
      if (RESERVED_SUBDOMAINS.has(v)) { setError('Tahle subdoména je rezervovaná. Zkuste jinou.'); subIn.focus(); return false; }
      state.subdomain = v;
      return true;
    }
    if (state.step === 4) {
      const checked = radios.querySelector('input[name="source"]:checked');
      if (!checked) { setError('Vyberte, odkud bereme obsah.'); return false; }
      state.sourceType = checked.value;
      return true;
    }
    return true;
  };

  const submit = async () => {
    nextBtn.disabled = true;
    prevBtn.disabled = true;
    cancelBtn.disabled = true;
    setError('');
    const payload = {
      email: state.email,
      consent: state.consent,
      subdomain: state.subdomain || null,
      wantsCustomDomain: state.wantsCustomDomain,
      sourceType: state.sourceType,
      ua: navigator.userAgent,
      ref: document.referrer || null,
      at: new Date().toISOString(),
    };
    try {
      const isDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
      if (isDev) {
        console.info('[wizard] dev — payload:', payload);
        await new Promise((r) => setTimeout(r, 400));
      } else {
        const res = await fetch(WAITLIST_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      renderSuccess();
    } catch (err) {
      console.error('waitlist submit failed', err);
      setError('Něco se pokazilo. Napište prosím na hromadadan@gmail.com — zařadíme ručně.');
      nextBtn.disabled = false;
      prevBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  };

  const renderSuccess = () => {
    panel.innerHTML = `
      <div class="wizard__success">
        <h3>Jste na seznamu.</h3>
        <p>Ozveme se vám na <strong>${escapeHtml(state.email)}</strong>, jakmile Hosted otevřeme. Žádný spam mezitím.</p>
        <p>Pokud chcete vývoj postrčit dopředu, klikněte na <strong>Přispět</strong> v rohu — díky.</p>
        <div class="wizard__buttons">
          <span></span>
          <button type="button" class="wizard__btn wizard__btn--primary" data-wizard-close>Zavřít</button>
        </div>
      </div>
    `;
    panel.querySelector('[data-wizard-close]').addEventListener('click', close);
  };

  prevBtn.addEventListener('click', () => {
    if (state.step > 1) { state.step -= 1; render(); }
  });
  nextBtn.addEventListener('click', () => {
    if (!validateStep()) return;
    if (state.step === TOTAL_STEPS) { submit(); return; }
    state.step += 1;
    render();
  });

  // Enter v inputu = pokračovat
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input[type="email"], input[type="text"]')) {
      e.preventDefault();
      nextBtn.click();
    }
  });

  // klik na radio-row aktivuje radio + označení rodiče
  radios.addEventListener('change', () => {
    radios.querySelectorAll('.wizard__radio').forEach((r) => {
      r.classList.toggle('wizard__radio--active', r.querySelector('input').checked);
    });
  });

  // přepínání „vlastní doména" disable / enable subdomain inputu
  customIn.addEventListener('change', () => {
    subIn.disabled = customIn.checked;
    if (customIn.checked) subIn.value = '';
  });

  // odkaz na záruku
  wrap.querySelector('[data-wizard-zaruka]').addEventListener('click', (e) => {
    e.preventDefault();
    close();
    const node = byPath?.get('about/zaruka.md');
    if (node && typeof openMain === 'function') openMain(node);
  });

  render();
}

// --- boot --------------------------------------------------------------------

async function boot() {
  const canvas = document.getElementById('canvas');
  const viewport = document.getElementById('viewport');
  const hits = document.getElementById('hits');

  // viewport — getView() je tolerantní na chybějící strom
  const vp = setupViewport(canvas, viewport, () => {
    const root = byPath.get(currentRootPath) || treeNodes.find((n) => n.type === 'root');
    if (!root || !currentBbox) return null;
    return { bb: currentBbox, rootNode: root };
  });
  viewportApi = vp;
  window.addEventListener('resize', vp.center);

  renderNav(null, vp);
  setupKeyboard(null, vp);

  // dblclick odešle nejdřív 1-2× click — single akci odložím, aby ji dblclick stihl zrušit
  let pendingSingle = null;
  const handleHit = (e, mode) => {
    const el = e.target.closest('.hit');
    if (!el) return;
    // hit button nesmí zůstat aktivní v DOM, jinak by Space na nej spustil click znova
    el.blur();
    const path = el.dataset.path;
    const node = byPath.get(path === '/' ? '' : path);
    if (!node) return;
    focusNode(node);
    // adresář (i root) = recenter, ne otevírání okna se stromem
    if (node.type === 'dir' || node.type === 'root') {
      if (pendingSingle) { clearTimeout(pendingSingle); pendingSingle = null; }
      recenter(node.path || '');
      return;
    }
    if (e.shiftKey) { openMainOnly(node); return; }
    // Cmd/Ctrl+klik = follower preview (totéž okno jako Space — toggluje, sleduje focus)
    if (e.metaKey || e.ctrlKey) { openAsFollower(node); return; }
    if (mode === 'new') {
      if (pendingSingle) { clearTimeout(pendingSingle); pendingSingle = null; }
      openPreview(node);
      return;
    }
    if (pendingSingle) clearTimeout(pendingSingle);
    pendingSingle = setTimeout(() => { pendingSingle = null; openMain(node); }, 220);
  };
  hits.addEventListener('click', (e) => handleHit(e, 'main'));
  hits.addEventListener('dblclick', (e) => handleHit(e, 'new'));

  setupDropZone();
  renderSourceMenu();
  mountBadge();
  renderEmptyHint(null);
  showEmptyState();
  // pokus o restore z IndexedDB — FS handle preferenčně, jinak GitHub.
  // Pokud uspěje, schová empty hint sám.
  (async () => {
    if (await tryRestoreSource()) return;
    if (await tryRestoreGithub()) return;
    if (await tryRestoreSnapshot()) return;
    await tryLoadStaticTree();
  })();
}

boot().catch((err) => {
  console.error(err);
  const map = document.getElementById('map');
  if (map) map.textContent = `chyba: ${err.message}`;
});
