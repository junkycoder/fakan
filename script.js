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
    raw: child.raw,
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
  for (let r = 0; r < bb.height; r++) {
    rows.push(new Array(bb.width).fill(' '));
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
    else if (n.kind === 'md') base += ' n--doc';
    else {
      const fn = (n.filename || n.name || '').toLowerCase();
      if (/\.(html|css|js|sh|py|json|ts|tsx)$/.test(fn)) base += ' n--code';
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

// --- autoplay (per-soubor) --------------------------------------------------
// Soubory v této množině se otevírají rovnou v rendered módu (iframe / md).
// Persistuje se v localStorage, aby toggle přežil reload.
const AUTOPLAY_KEY = 'fakan.autoplay';
let autoplayPaths = new Set();
try {
  const raw = localStorage.getItem(AUTOPLAY_KEY);
  if (raw) autoplayPaths = new Set(JSON.parse(raw));
} catch {}

function saveAutoplay() {
  try { localStorage.setItem(AUTOPLAY_KEY, JSON.stringify([...autoplayPaths])); } catch {}
}

function toggleAutoplay(path) {
  if (autoplayPaths.has(path)) autoplayPaths.delete(path);
  else autoplayPaths.add(path);
  saveAutoplay();
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
let panelZ = 100;
let panelNavListener = null;     // callback do nav re-renderu
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
  currentRootPath = path || '';
  rebuildMindmap();
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
  for (let r = 0; r < bb.height; r++) rows.push(new Array(bb.width).fill(' '));
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
  for (let r = 0; r < bb.height; r++) {
    const arr = nodesByRow.get(r) || [];
    let cursor = 0;
    const line = rows[r];
    let out = '';
    for (const n of arr) {
      out += escapeHtml(line.slice(cursor, n.localCol).join(''));
      out += `<span class="n ${nodeClass(n)}">${escapeHtml(n.name)}</span>`;
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
  const raw = node.raw != null ? node.raw : (node.content || '');
  if (!raw) {
    return `<p class="panel__note empty">Prázdný soubor <code>${escapeHtml(node.filename || node.name)}</code>.</p>`;
  }
  return `<pre class="src"><code>${escapeHtml(raw)}</code></pre>`;
}

function renderedBody(node) {
  if (node.kind === 'md' && node.content) {
    return `<div class="md">${renderMarkdown(node.content)}</div>`;
  }
  const fn = (node.filename || node.name || '').toLowerCase();
  if ((fn.endsWith('.html') || fn.endsWith('.htm')) && node.raw) {
    // self-contained iframe přes srcdoc; sandbox bez allow-same-origin = bezpečné
    const srcdoc = node.raw
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return `<iframe class="iframe-preview" srcdoc="${srcdoc}" sandbox="allow-scripts" title="${escapeHtml(node.filename || node.name)}"></iframe>`;
  }
  // adresář s index.html: vyrenderuj jeho index.html
  const idx = dirIndexHtml(node);
  if (idx) {
    const srcdoc = idx.raw.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return `<iframe class="iframe-preview" srcdoc="${srcdoc}" sandbox="allow-scripts" title="${escapeHtml(node.name + '/index.html')}"></iframe>`;
  }
  if (node.kind === 'md') {
    return `<p class="panel__note empty">Žádný obsah k vyrendrování.</p>`;
  }
  return sourceBody(node);
}

function dirIndexHtml(node) {
  if (!node || node.type !== 'dir') return null;
  const idx = byPath.get((node.path || '') + '/index.html');
  return idx && idx.raw ? idx : null;
}

function canBuild(node) {
  if (node.kind === 'md' && node.content && node.content.trim()) return true;
  const fn = (node.filename || node.name || '').toLowerCase();
  if ((fn.endsWith('.html') || fn.endsWith('.htm')) && node.raw) return true;
  if (dirIndexHtml(node)) return true;
  return false;
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
  // Dir s index.html otevírám rovnou jako rendered (source pro dir nedává smysl).
  // Pro soubory respektuju per-soubor autoplay flag.
  const isAutoDir = node.type === 'dir' && !!dirIndexHtml(node);
  const autoplay = buildable && (isAutoDir || autoplayPaths.has(path));
  const initialMode = autoplay ? 'rendered' : 'source';
  // Auto toggle ukazuju jen pro soubory — u dir je rendered defaultní.
  const showAuto = buildable && node.type !== 'dir';
  const autoOn = autoplayPaths.has(path);
  const playLabel = initialMode === 'source' ? 'play' : 'src';
  const playTitle = initialMode === 'source' ? 'Sestavit / náhled' : 'Zpět na zdroj';
  el.innerHTML = `
    <header class="panel__head" data-panel-head>
      <span class="panel__path">${escapeHtml(pathLabel(node))}</span>
      <div class="panel__actions">
        ${buildable ? `<button class="panel__btn panel__btn--play${initialMode === 'rendered' ? ' is-active' : ''}" type="button" data-panel-play title="${playTitle}" aria-label="Sestavit">${playLabel}</button>` : ''}
        ${showAuto ? `<button class="panel__btn panel__btn--auto${autoOn ? ' is-active' : ''}" type="button" data-panel-auto title="Otevírat rovnou v náhledu" aria-label="Autoplay">auto</button>` : ''}
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
  };
  return panel;
}

function positionPanel(panel) {
  const el = panel.element;
  if (panel.variant === 'main') {
    el.style.right = '16px';
    el.style.top = `calc(16px + var(--safe-t))`;
  } else {
    const stack = previewPanels.size;
    el.style.right = `${24 + stack * 28}px`;
    el.style.top = `calc(${24 + stack * 28}px + var(--safe-t))`;
  }
}

function setupPanelInteractions(panel) {
  const el = panel.element;
  const head = el.querySelector('[data-panel-head]');
  const playBtn = el.querySelector('[data-panel-play]');
  const autoBtn = el.querySelector('[data-panel-auto]');
  const maxBtn = el.querySelector('[data-panel-max]');
  const closeBtn = el.querySelector('[data-panel-close]');
  const bodyEl = el.querySelector('[data-panel-body]');

  closeBtn.addEventListener('click', () => closePanel(panel));

  if (autoBtn) {
    autoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAutoplay(panel.path);
      autoBtn.classList.toggle('is-active', autoplayPaths.has(panel.path));
    });
  }

  if (playBtn) {
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.mode = panel.mode === 'source' ? 'rendered' : 'source';
      bodyEl.innerHTML = panel.mode === 'source' ? sourceBody(panel.node) : renderedBody(panel.node);
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
  panel.element.remove();
  if (panel === mainPanel) mainPanel = null;
  else previewPanels.delete(panel.path);
  if (panel === followerPanel) followerPanel = null;
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

  // sekce v dropdown — vždy top-level dirs SKUTEČNÉHO kořene (i po recenter)
  const topDirs = (originalTree?.children || []).filter((c) => c.type === 'dir');
  dropdown.innerHTML = '';
  for (const d of topDirs) {
    const a = document.createElement('a');
    a.className = 'nav__section';
    a.href = '#';
    a.dataset.path = d.name;
    a.textContent = d.name;
    dropdown.appendChild(a);
  }

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

  // klik handlery
  document.getElementById('nav').addEventListener('click', (e) => {
    const homeBtn = e.target.closest('[data-home-btn]');
    if (homeBtn) {
      // ~/ = vrať mindmapu na skutečný kořen
      recenter('');
      return;
    }
    const section = e.target.closest('.nav__section');
    if (section) {
      e.preventDefault();
      const path = section.dataset.path;
      // sekce → recenter na tu složku (stane se novým středem)
      recenter(path);
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
    // pokud uživatel píše do inputu / contenteditable, šipky nepřebíráme
    const tgt = e.target;
    const tag = tgt && tgt.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (tgt && tgt.isContentEditable)) return;

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
      // Shift+Enter na adresáři = ten se stane novým středem (recenter)
      if (e.shiftKey && node.type === 'dir') {
        recenter(node.path);
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

// --- boot --------------------------------------------------------------------

async function boot() {
  const res = await fetch(TREE_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`tree.json: ${res.status}`);
  const tree = await res.json();
  originalTree = tree;
  currentRootPath = '';

  const canvas = document.getElementById('canvas');
  const viewport = document.getElementById('viewport');
  const map = document.getElementById('map');
  const labels = document.getElementById('labels');
  const hits = document.getElementById('hits');

  const grid = buildMindmap(tree, '');
  treeNodes = grid.nodes;
  buildTreeIndex(grid.nodes);
  currentBbox = paint(map, labels, hits, grid);
  const rootNode = grid.nodes.find((n) => n.type === 'root');

  const vp = setupViewport(canvas, viewport, () => {
    const root = byPath.get(currentRootPath) || rootNode;
    return { bb: currentBbox, rootNode: root };
  });
  viewportApi = vp;
  requestAnimationFrame(vp.center);
  window.addEventListener('resize', vp.center);

  renderNav(grid, vp);
  setupKeyboard(grid, vp);
  if (rootNode) focusNode(rootNode);

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
}

boot().catch((err) => {
  console.error(err);
  const map = document.getElementById('map');
  if (map) map.textContent = `chyba načítání: ${err.message}`;
});
