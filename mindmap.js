// Mindmapa: char grid → layout → render → viewport + tree-index a re-rooting.
// Závisí jen na state.js (čisté funkce + sdílený state).

import {
  state,
  CHAR_W, LINE_H, ROOT_SCALE, DIR_QUADRANT,
  escapeHtml, cssEscapePath, loadAllEditOverrides,
  pushTreeOp, makeNewNode, LS_EDIT_PREFIX,
} from './state.js';
import { syncFromState } from './url.js';

const RECENTER_HIST_KEY = 'fakan.recenterHistory';
const RECENTER_FWD_KEY = 'fakan.recenterForward';

// Top-level uzel s nejméně tolika dětmi se rozkošatí do sub-stran (W+S+E).
// Pod prahem zůstává lineární, aby sourozenci v jednom kvadrantu na sebe nenarazili.
const BRANCH_THRESHOLD = 6;
// Kolik buněk maximálně posunout sub-body při hledání volného místa, než to vzdáme.
const MAX_PLACEMENT_TRIES = 30;

function persistRecenterStacks() {
  try {
    sessionStorage.setItem(RECENTER_HIST_KEY, JSON.stringify(state.recenterHistory));
    sessionStorage.setItem(RECENTER_FWD_KEY, JSON.stringify(state.recenterForward));
  } catch {}
}

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
    // FSA handle (drag&drop / „Otevřít složku") musí přežít build mindmapy,
    // jinak panel v rootHandle režimu neumí dotáhnout obsah a padá na fetch.
    _handle: child._handle,
  };
}

const charForDirs = (d) => {
  const k = (d.n?1:0) | ((d.s?1:0)<<1) | ((d.e?1:0)<<2) | ((d.w?1:0)<<3);
  return [' ','│','│','│','─','└','┌','├','─','┘','┐','┤','─','┴','┬','┼'][k];
};

// Truncation: ve složkách s mnoha plochými soubory ukážeme jen posledních N
// (abecedně, reverzně ~ „nejnovější" pro datované názvy) + virtual „more" uzel.
// Klik na more recentuje do té složky, kde uživatel vidí celou strukturu.
const TRUNCATE_THRESHOLD = 12;
const TRUNCATE_KEEP = 8;

function maybeTruncate(children, parentPath) {
  if (!children || children.length <= TRUNCATE_THRESHOLD) return children;
  if (children.some((c) => c.type === 'more')) return children;
  const dirs = children.filter((c) => c.type === 'dir');
  const files = children.filter((c) => c.type === 'file');
  const baseBudget = Math.max(1, TRUNCATE_KEEP - dirs.length);
  const extra = state.expandedMore.get(parentPath || '') || 0;
  const budget = baseBudget + extra;
  if (files.length <= budget) return children;
  const keep = files.slice(-budget);
  const hidden = files.length - keep.length;
  return [...dirs, ...keep, {
    name: `+ ${hidden} dalších`,
    type: 'more',
    targetPath: parentPath || '',
  }];
}

// Klik na „+ N dalších" — odhalí další várku in-place místo recenteru.
// Vrací true, pokud došlo k odhalení (alespoň jeden uzel nově viditelný).
export function revealMore(targetPath) {
  const key = targetPath || '';
  const cur = state.expandedMore.get(key) || 0;
  state.expandedMore.set(key, cur + TRUNCATE_KEEP);
  // keepViewport: layout mindmapy se zvětší (přibyly řádky), ale nesmíme
  // uživateli skočit viewportem — má vidět nové položky, ne změnu pozice.
  rebuildMindmap(state.focusedPath, { keepViewport: true });
  return true;
}

// --- layout: down-body (standardní `tree`) -----------------------------------
// Vrátí nový `body` grid s trunk col = 0 a první dítě na row 0.
// `sepTop` = počet prázdných řádků mezi top-level dětmi (vizuální oddělení skupin).
// `branchify` = pokud true, top-level děti (depth=0) s ≥3 vnořenými dětmi se
// rozkošatí přes `layoutSubBranches` (W + S + E sub-strany kolem uzlu) místo
// klasického lineárního indented podstromu. Sub-strany jsou v lokálních souřadnicích;
// vnější `flipBody*` v buildMindmap je správně přeloží do globální orientace.

function layoutBody(children, pathPrefix = '', sepTop = 1, branchify = false) {
  const g = makeGrid();
  g.topRows = []; // řádky top-level dětí — pro vystředění root spojnice mimo node
  let cursor = 0;

  const walk = (subs, prefix, parentPath, depth) => {
    subs = maybeTruncate(subs, parentPath);
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
      const isMore = child.type === 'more';
      const isLast = i === n - 1;
      const row = cursor++;
      if (depth === 0) g.topRows.push(row);
      // pro file uzly konstruuj path z `filename` (web uzly mají `name` jen jako display label);
      // pro dir je filename undefined → fallback na name.
      // 'more' uzly mají syntetickou cestu, aby nekolidovaly s reálnými dětmi.
      let path;
      if (isMore) {
        path = parentPath ? `${parentPath}/__more__` : '__more__';
      } else {
        const seg = child.type === 'file' ? (child.filename || child.name) : child.name;
        path = parentPath ? `${parentPath}/${seg}` : seg;
      }

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
        hasChildren: !isMore && !!(child.children && child.children.length),
        ...(isMore ? { targetPath: child.targetPath } : fileMeta(child)),
      });

      if (!isMore && child.children && child.children.length) {
        // truncate child.children jednou — propaguje se jak do branchify (split),
        // tak do lineárního walku níž; zabrání dvojím „more" uzlům na obou polovinách.
        const kids = maybeTruncate(child.children, path);
        // 2. úroveň — rozkošatění top-level uzlů s dost dětmi do W+S+E sub-stran.
        // Spočítáme sub-grid a vložíme ho s anchor (0,0) = první znak jména uzlu.
        // BRANCH_THRESHOLD — menší uzly zůstanou lineární, aby sub-strany sourozenců
        // uvnitř stejného kvadrantu na sebe nenarážely.
        if (branchify && depth === 0 && child.type === 'dir' && kids.length >= BRANCH_THRESHOLD) {
          const sub = layoutSubBranches(kids === child.children ? child : { ...child, children: kids }, path);

          composeBody(g, sub, row, cc + 4);
          const sb = bbox(sub);
          // Posun cursoru pod nejnižší řadu sub-strany (S forward jde dolů).
          // +2 = 1 prázdný řádek pro vizuální oddělení od dalšího sourozence.
          const advance = Math.max(1, sb.maxR);
          // Doplnit svislý trunk parent layoutBody na col=0 přes řady, které sub-strana
          // překlenuje vertikálně (mezi `app` a dalším sourozencem nesmí čára zmizet).
          // Jen pokud uzel není poslední — pro poslední (└) trunk dál nepokračuje.
          if (!isLast) {
            for (let r = row + 1; r <= row + advance + 1; r++) {
              gridConn(g, r, 0, { n: true, s: true });
            }
          }
          cursor = row + advance + 2;
          continue;
        }
        const newPrefix = prefix + (isLast ? '    ' : '|   ');
        walk(kids, newPrefix, path, depth + 1);
      }
    }
  };

  walk(children, '', pathPrefix, 0);
  return g;
}

// --- 2. úroveň: rozkošatění top-level uzlu do W + S + E sub-stran ----------
// Lokální anchor (0, 0) = první znak jména uzlu; uzel samotný **neemittujeme**
// (je už vykreslen volajícím `layoutBody`'s walk). Vracíme jen sub-strany +
// napojovací konektory.

// Rozdělí děti na 2 bloky: forward (≈ polovina) a wing (zbytek).
// Wing dostane menší podíl, aby pokračování trunku zůstalo dominantní.
function splitChildrenByIndex(children) {
  const n = children.length;
  const fwd = Math.ceil(n / 2);
  return [
    children.slice(0, fwd),
    children.slice(fwd),
  ];
}

function occupiedCells(g) {
  const occ = new Set();
  for (const k of g.conn.keys()) occ.add(k);
  for (const node of g.nodes) {
    for (let i = 0; i < node.name.length; i++) {
      occ.add(ckey(node.row, node.col + i));
    }
  }
  return occ;
}

function bodyCollides(occ, body, dRow, dCol) {
  for (const k of body.conn.keys()) {
    const [r, c] = k.split('|').map(Number);
    if (occ.has(ckey(r + dRow, c + dCol))) return true;
  }
  for (const node of body.nodes) {
    for (let i = 0; i < node.name.length; i++) {
      if (occ.has(ckey(node.row + dRow, node.col + dCol + i))) return true;
    }
  }
  return false;
}

// Posune `body` od `(baseRow, baseCol)` ve směru `axis` dokud nepřestane kolidovat
// s obsazenými buňkami v `dst`. Po MAX_PLACEMENT_TRIES iteracích vrátí poslední pokus.
function placeWithoutCollision(dst, body, baseRow, baseCol, axis) {
  const occ = occupiedCells(dst);
  let dRow = baseRow, dCol = baseCol;
  for (let i = 0; i < MAX_PLACEMENT_TRIES; i++) {
    if (!bodyCollides(occ, body, dRow, dCol)) return { dRow, dCol };
    if (axis === 'row-down') dRow++;
    else if (axis === 'col-right') dCol++;
    else if (axis === 'col-left') dCol--;
    else dRow++;
  }
  return { dRow, dCol };
}

function layoutSubBranches(parentNode, parentPath) {
  const g = makeGrid();
  const nameLen = parentNode.name.length;
  // Trunk pod jménem padá přibližně do středu — pro lichý počet znaků přesně na střed,
  // pro sudý zaokrouhleno dolů (vlevo od skutečného středu).
  const nameMidCol = Math.floor((nameLen - 1) / 2);

  // Rozkošatění jen do S (forward) + E (vpravo). W sub-strana by zasahovala
  // vertikálně do prostoru WEST kvadrantu rootu (kolize s top-level WEST sourozenci
  // na sousedních řadách), proto ji vynecháme úplně.
  const [southKids, eastKids] = splitChildrenByIndex(parentNode.children);

  // SOUTH (forward) -----------------------------------------------------------
  if (southKids.length) {
    const sub = layoutBody(southKids, parentPath, 0);
    // sub.trunk col=0 → lokální col=nameMidCol
    // sub.first child row=0 → lokální row=2 (1 řádek svislé spojnice mezi jménem a sub-trunkem)
    const baseDRow = 2;
    const baseDCol = nameMidCol;
    const { dRow, dCol } = placeWithoutCollision(g, sub, baseDRow, baseDCol, 'row-down');
    composeBody(g, sub, dRow, dCol);
    // Svislá spojnice od jména k sub-trunku
    for (let r = 1; r < dRow; r++) {
      gridConn(g, r, dCol, { n: true, s: true });
    }
  }

  // EAST ----------------------------------------------------------------------
  if (eastKids.length) {
    const sub = layoutBody(eastKids, parentPath, 0);
    const sb = bbox(sub);
    const midRow = midGapRow(sub.topRows, sb);
    const trunkOffset = 4;
    const baseDRow = 0 - midRow;
    const baseDCol = nameLen + trunkOffset;
    const { dRow, dCol } = placeWithoutCollision(g, sub, baseDRow, baseDCol, 'col-right');
    composeBody(g, sub, dRow, dCol);
    // Vodorovná spojnice z (0, nameLen) doprava na (0, dCol)
    for (let c = nameLen; c < dCol; c++) {
      gridConn(g, 0, c, { e: true, w: true });
    }
    gridConn(g, 0, dCol, { w: true });
    // Vyčistit n/s konce trunku — root spojnice přichází zboku, ne shora/zdola
    gridClearDirs(g, dRow + sb.minR, dCol, { n: true });
    gridClearDirs(g, dRow + sb.maxR, dCol, { s: true });
  }

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

export function classify(child) {
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

export function buildMindmap(tree, basePath = '') {
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
  // Branchify jen v SOUTH/NORTH (vertikální kvadranty), kde je horizontální prostor.
  // EAST/WEST zůstanou lineární — sub-strany top-level uzlů by se uvnitř těchto
  // úzkých horizontálních pásů křižovaly.
  let eastInfo = null, westInfo = null;
  if (q.east.length) {
    const body = layoutBody(q.east, basePath, 1, false);
    const bb = bbox(body);
    const midRow = midGapRow(body.topRows, bb);
    const dRow = rootRow - midRow;
    eastInfo = { body, bb, dRow, topRow: dRow + bb.minR, bottomRow: dRow + bb.maxR };
  }
  if (q.west.length) {
    const body = layoutBody(q.west, basePath, 1, false);
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
    const body = layoutBody(q.south, basePath, 1, true);
    composeBody(g, body, southStart, 0);
    for (let r = rootRow + 1; r < southStart; r++) {
      gridConn(g, r, 0, { n: true, s: true });
    }
  }

  // NORTH ---------------------------------------------------------------
  if (q.north.length) {
    const body = layoutBody(q.north, basePath, 1, true);
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

export function nodeClass(n) {
  let base;
  if (n.type === 'root') {
    base = 'n--root n--depth-0';
  } else if (n.type === 'more') {
    const depth = (n.path || '').split('/').filter(Boolean).length;
    base = `n--depth-${Math.min(depth, 5)} n--more`;
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

// --- DOM rendering -----------------------------------------------------------

export function paint(map, labels, hits, grid) {
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
    if (n.targetPath != null) el.dataset.targetPath = n.targetPath || '/';
    el.style.top = `${n.localRow * LINE_H}px`;
    el.style.left = `${n.localCol * CHAR_W}px`;
    el.style.width = `${n.name.length * CHAR_W}px`;
    el.setAttribute('aria-label', `${n.type === 'root' ? 'root ' : ''}${n.name}`);
    hits.appendChild(el);
  }

  return bb;
}

// --- pan / zoom --------------------------------------------------------------

export function setupViewport(canvas, viewport, getView) {
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

// --- tree index + re-rooting ------------------------------------------------

export function topLevelAncestor(nodePath, rootPath) {
  let p = nodePath;
  while (true) {
    const parts = p.split('/');
    const parent = parts.slice(0, -1).join('/');
    if (parent === rootPath) return p;
    if (!parent) return p;
    p = parent;
  }
}

export function buildTreeIndex(nodes) {
  const { byPath, childrenByPath, topQuadrant } = state;
  byPath.clear();
  childrenByPath.clear();
  topQuadrant.clear();
  for (const n of nodes) {
    if (n.type === 'more') continue;
    byPath.set(n.path || '', n);
  }
  for (const n of nodes) {
    if (n.type === 'root' || n.type === 'more') continue;
    const parts = n.path.split('/');
    const parentPath = parts.slice(0, -1).join('/');
    if (!childrenByPath.has(parentPath)) childrenByPath.set(parentPath, []);
    childrenByPath.get(parentPath).push(n);
  }
  // top-level vůči aktuálnímu středu = parent == currentRootPath
  const tops = childrenByPath.get(state.currentRootPath) || [];
  for (const n of tops) topQuadrant.set(n.path, classify(n));
  // přiřaď kvadrant všem potomkům (zděděný od top-level předka)
  for (const n of nodes) {
    if (n.type === 'root') { n.quadrant = null; continue; }
    if (n.type === 'more') {
      // more uzel zdědí kvadrant rodiče (vykreslí se uvnitř téhož sloupce stromu)
      const parts = n.path.split('/');
      const parentPath = parts.slice(0, -1).join('/');
      const parent = byPath.get(parentPath);
      n.quadrant = parent ? parent.quadrant : null;
      continue;
    }
    const top = topLevelAncestor(n.path, state.currentRootPath);
    n.quadrant = topQuadrant.get(top);
  }
}

export function findSubtree(tree, path) {
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

export function rebuildMindmap(focusPath, { keepViewport = false } = {}) {
  if (!state.originalTree) return;
  const sub = findSubtree(state.originalTree, state.currentRootPath);
  if (!sub) return;
  const grid = buildMindmap(sub, state.currentRootPath);
  const map = document.getElementById('map');
  const labels = document.getElementById('labels');
  const hits = document.getElementById('hits');
  // pořadí: index nejdřív (vyplní n.quadrant), pak paint (čte ho pro data-quadrant)
  state.treeNodes = grid.nodes;
  buildTreeIndex(grid.nodes);
  loadAllEditOverrides(grid.nodes);
  state.currentBbox = paint(map, labels, hits, grid);
  const rootNode = grid.nodes.find((n) => n.type === 'root');
  const target = focusPath != null
    ? (state.byPath.get(focusPath) || rootNode)
    : rootNode;
  if (target) focusNode(target);
  refreshOpenLabels();
  if (state.viewportApi && !keepViewport) {
    requestAnimationFrame(state.viewportApi.center);
  }
}

// recenter — { silent: true } přeskočí pushState (init z URL / popstate si URL
// už řídí sám). User akce dělá SPA in-place update: změní strom, pushne URL,
// otevřené panely zachová. Cmd+šipka zpět funguje přes nativní popstate.
// recenterHistory přežívá reload přes sessionStorage.
// mode: 'forward' (normal Enter/klik) zahodí forward stack; 'back' (Cmd+←) /
// 'redo' (Cmd+→) ho zachová — volající si ho upraví sám.
export function recenter(path, { silent = false, mode = 'forward' } = {}) {
  const next = path || '';
  if (next === state.currentRootPath) return;
  // ulož předchozí root do historie (dedup, cap)
  if (state.currentRootPath) {
    state.recenterHistory = state.recenterHistory.filter((p) => p !== state.currentRootPath);
    state.recenterHistory.unshift(state.currentRootPath);
    if (state.recenterHistory.length > 30) state.recenterHistory.length = 30;
  }
  // nový root nesmí být zároveň v historii
  state.recenterHistory = state.recenterHistory.filter((p) => p !== next);
  if (mode === 'forward') state.recenterForward = [];

  state.currentRootPath = next;
  rebuildMindmap();
  if (state.routeNavListener) state.routeNavListener();

  if (!silent) {
    persistRecenterStacks();
    syncFromState();
  }
}

// Cmd+← — skok na rodičovskou cestu, současný root se uloží do forward stacku,
// aby šel Cmd+→ vrátit zpátky do stejné slozky.
export function recenterBack(path) {
  if (state.currentRootPath != null && state.currentRootPath !== '') {
    state.recenterForward = state.recenterForward.filter((p) => p !== state.currentRootPath);
    state.recenterForward.unshift(state.currentRootPath);
    if (state.recenterForward.length > 30) state.recenterForward.length = 30;
  }
  recenter(path, { mode: 'back' });
}

// Cmd+→ — vrátit se do slozky, ze které jsme šli Cmd+← ven.
export function recenterForwardStep() {
  if (!state.recenterForward.length) return false;
  const next = state.recenterForward.shift();
  recenter(next, { mode: 'redo' });
  return true;
}

// Volá se v bootu — obnoví historii z předchozí navigace ve stejném tabu.
export function restoreRecenterHistory() {
  try {
    const raw = sessionStorage.getItem(RECENTER_HIST_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        state.recenterHistory = parsed.filter((p) => typeof p === 'string');
      }
    }
    const rawFwd = sessionStorage.getItem(RECENTER_FWD_KEY);
    if (rawFwd) {
      const parsedFwd = JSON.parse(rawFwd);
      if (Array.isArray(parsedFwd)) {
        state.recenterForward = parsedFwd.filter((p) => typeof p === 'string');
      }
    }
  } catch {}
}

export function removeFromHistory(path) {
  state.recenterHistory = state.recenterHistory.filter((p) => p !== path);
  state.recenterForward = state.recenterForward.filter((p) => p !== path);
  if (state.routeNavListener) state.routeNavListener();
}

// --- focus / open labels (DOM třídy nad mindmapou) --------------------------

export function focusNode(node) {
  state.focusedPath = node.path || '';
  // .hit (a11y / pointer target) — beze stylu, jen pro skripty
  document.querySelectorAll('.hit--focus').forEach((el) => el.classList.remove('hit--focus'));
  const hit = document.querySelector(`.hit[data-path="${cssEscapePath(state.focusedPath || '/')}"]`);
  if (hit) hit.classList.add('hit--focus');
  // vizuální focus = bold žluté písmo v .labels
  document.querySelectorAll('.labels .n--focus').forEach((el) => el.classList.remove('n--focus'));
  const span = document.querySelector(`.labels [data-node-path="${cssEscapePath(state.focusedPath || '/')}"]`);
  if (span) span.classList.add('n--focus');
}

export function refreshOpenLabels() {
  const open = new Set();
  if (state.mainPanel) open.add(state.mainPanel.path);
  for (const p of state.previewPanels.values()) open.add(p.path);
  document.querySelectorAll('.labels .n--open').forEach((el) => el.classList.remove('n--open'));
  for (const path of open) {
    const span = document.querySelector(`.labels [data-node-path="${cssEscapePath(path)}"]`);
    if (span) span.classList.add('n--open');
  }
}

// --- helper pro panely: renderTreeInlineHTML --------------------------------
// Reuse char-grid logiky z buildMindmap → renderGrid, ale s texty inline ve <pre>.
export function renderTreeInlineHTML(grid) {
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
      const isMore = n.type === 'more';
      const isDir = n.type === 'dir' || n.type === 'root';
      // root dir-panelu nesmaž (mažeš jeho ze stromu nadřazeným panelem);
      // jinak povolíme `-`. `+` na všech dir/root.
      const isPanelRoot = n.type === 'root' || dp === '/';
      const addBtn = isDir && !isMore
        ? `<button class="n-add" type="button" data-add-parent="${escapeHtml(dp)}" tabindex="-1" aria-label="Přidat do ${escapeHtml(n.name)}">+</button>`
        : '';
      const rmBtn = !isPanelRoot && !isMore
        ? `<button class="n-rm" type="button" data-rm-path="${escapeHtml(dp)}" data-rm-type="${escapeHtml(n.type)}" tabindex="-1" aria-label="Smazat ${escapeHtml(n.name)}">−</button>`
        : '';
      const targetAttr = isMore ? ` data-target-path="${escapeHtml(n.targetPath || '/')}"` : '';
      out += `<span class="n ${nodeClass(n)}" data-path="${escapeHtml(dp)}" data-type="${escapeHtml(n.type)}"${targetAttr} role="button" tabindex="0">${escapeHtml(n.name)}${addBtn}${rmBtn}</span>`;
      cursor = n.localCol + n.name.length;
    }
    out += escapeHtml(line.slice(cursor).join(''));
    html.push(out);
  }
  return html.join('\n');
}

export function renderDirTree(dirNode) {
  const sub = findSubtree(state.originalTree, dirNode.path);
  if (!sub) return '<p class="panel__note empty">Strom nenalezen.</p>';
  const grid = buildMindmap(sub, dirNode.path);
  return `<pre class="src-tree">${renderTreeInlineHTML(grid)}</pre>`;
}

// --- add / remove uzlu v originalTree --------------------------------------
// Mutuje originalTree, zaloguje op do LS, rebuilduje mindmapu. Funguje na
// libovolný zdroj (local, snapshot, github) — overlay je čistě klient-side.

export function addTreeNode(parentPath, rawName) {
  if (!state.originalTree) return null;
  let name = String(rawName || '').trim();
  if (!name) return null;
  // koncový `/` znamená dir; jinak file. Sanitace názvu — bez slashů uvnitř.
  let isDir = false;
  if (name.endsWith('/')) { isDir = true; name = name.slice(0, -1).trim(); }
  if (!name || name.includes('/') || name === '.' || name === '..') return null;

  const parent = findSubtree(state.originalTree, parentPath || '');
  if (!parent) return null;
  if (!Array.isArray(parent.children)) parent.children = [];
  if (parent.children.some((c) => c.name === name)) return null;

  parent.children.push(makeNewNode(name, isDir));
  pushTreeOp({ op: 'add', parent: parentPath || '', name, isDir });
  try { window.dispatchEvent(new CustomEvent('fakan:tree-changed')); } catch {}
  return (parentPath ? `${parentPath}/${name}` : name);
}

export function removeTreeNode(path) {
  if (!state.originalTree || !path) return false;
  const parts = path.split('/');
  const name = parts.pop();
  const parent = findSubtree(state.originalTree, parts.join('/'));
  if (!parent || !Array.isArray(parent.children)) return false;
  const before = parent.children.length;
  parent.children = parent.children.filter((c) => c.name !== name);
  if (parent.children.length === before) return false;
  pushTreeOp({ op: 'rm', path });
  // edit overlay pro smazaný soubor už nemá smysl
  try { localStorage.removeItem(LS_EDIT_PREFIX + path); } catch {}
  try { window.dispatchEvent(new CustomEvent('fakan:tree-changed')); } catch {}
  return true;
}
