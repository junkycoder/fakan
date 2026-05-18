// Drag & drop reordering — prototype.
// Tah za .hit uzlu mění pořadí mezi sourozenci v parent.children.
// Snap-to-grid pro ghost (vizuální), drop indikátor mezi sourozenci.

import { state, CHAR_W, LINE_H, pushTreeOp, cssEscapePath } from './state.js';
import { findSubtree, rebuildMindmap } from './mindmap.js';

const DRAG_THRESHOLD = 5;

let drag = null;
// { path, name, type, startX, startY, parentPath, siblings, ghost, indicator,
//   active, suppressClick, targetIndex }

function viewportTransform() {
  const vp = document.getElementById('viewport');
  const m = new DOMMatrixReadOnly(getComputedStyle(vp).transform);
  return { tx: m.e, ty: m.f, scale: m.a };
}

function snapToGrid(clientX, clientY) {
  const map = document.getElementById('map');
  const rect = map.getBoundingClientRect();
  const { scale } = viewportTransform();
  const localX = (clientX - rect.left) / scale;
  const localY = (clientY - rect.top) / scale;
  const col = Math.round(localX / CHAR_W);
  const row = Math.round(localY / LINE_H);
  return {
    clientX: rect.left + col * CHAR_W * scale,
    clientY: rect.top + row * LINE_H * scale,
    scale,
  };
}

function siblingHits() {
  const out = [];
  for (const sib of drag.siblings) {
    if (sib.path === drag.path) continue;
    if (sib.type === 'more') continue;
    const el = document.querySelector(`.hit[data-path="${cssEscapePath(sib.path || '/')}"]`);
    if (!el) continue;
    out.push({ sib, el, rect: el.getBoundingClientRect() });
  }
  return out;
}

// Najdi cílový index mezi sourozenci podle Y-pozice pointeru.
// Vrací { index, refRect, before } — kam vložit + kam nakreslit indikátor.
function pickTarget(clientY) {
  const hits = siblingHits();
  if (!hits.length) return { index: drag.originalIndex, refRect: null, before: true };

  // Seřaď podle Y centra. Najdi pár sousedů, mezi které pointer padá.
  const sorted = hits
    .map((h) => ({ ...h, cy: h.rect.top + h.rect.height / 2 }))
    .sort((a, b) => a.cy - b.cy);

  // nad prvním
  if (clientY < sorted[0].cy) {
    return refToIndex(sorted[0], true);
  }
  // pod posledním
  const last = sorted[sorted.length - 1];
  if (clientY > last.cy) {
    return refToIndex(last, false);
  }
  // mezi
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (clientY >= a.cy && clientY <= b.cy) {
      const mid = (a.cy + b.cy) / 2;
      return clientY < mid ? refToIndex(a, false) : refToIndex(b, true);
    }
  }
  return refToIndex(sorted[0], true);
}

// before=true → vložit před sib v rodičovských children
function refToIndex(entry, before) {
  const siblings = drag.siblings;
  const sibIdx = siblings.findIndex((s) => s.path === entry.sib.path);
  let idx = before ? sibIdx : sibIdx + 1;
  // adjustace: pokud odstraňujeme z menšího indexu, cílový index se posune dolů
  if (drag.originalIndex < idx) idx -= 1;
  return { index: idx, refRect: entry.rect, before };
}

function moveGhost(clientX, clientY) {
  if (!drag.ghost) return;
  const snap = snapToGrid(clientX, clientY);
  drag.ghost.style.transform = `translate(${snap.clientX}px, ${snap.clientY}px) translate(-2px, ${-(LINE_H * snap.scale) / 2}px) scale(${snap.scale})`;
}

function moveIndicator(target) {
  if (!drag.indicator) return;
  if (!target.refRect) {
    drag.indicator.style.opacity = '0';
    return;
  }
  const r = target.refRect;
  const y = target.before ? r.top - 2 : r.bottom;
  drag.indicator.style.opacity = '1';
  drag.indicator.style.left = `${r.left - 6}px`;
  drag.indicator.style.top = `${y}px`;
  drag.indicator.style.width = `${r.width + 12}px`;
}

function makeGhost(name, type) {
  const g = document.createElement('div');
  g.className = `dnd-ghost n--${type === 'dir' ? 'dir' : 'other'}`;
  g.textContent = name;
  document.body.appendChild(g);
  return g;
}

function makeIndicator() {
  const i = document.createElement('div');
  i.className = 'dnd-drop-indicator';
  i.style.opacity = '0';
  document.body.appendChild(i);
  return i;
}

function cleanup() {
  if (!drag) return;
  if (drag.ghost) drag.ghost.remove();
  if (drag.indicator) drag.indicator.remove();
  document.body.classList.remove('is-dragging-node');
  drag = null;
}

function applyReorder(newIndex) {
  const parent = findSubtree(state.originalTree, drag.parentPath || '');
  if (!parent || !Array.isArray(parent.children)) return false;
  const idx = parent.children.findIndex((c) => c.name === drag.name);
  if (idx < 0) return false;
  const [moved] = parent.children.splice(idx, 1);
  const clamped = Math.max(0, Math.min(newIndex, parent.children.length));
  parent.children.splice(clamped, 0, moved);
  // Dedup: pokud poslední op je 'order' pro stejného rodiče, přepiš ho.
  const order = parent.children.map((c) => c.name);
  const last = state.treeOps[state.treeOps.length - 1];
  if (last && last.op === 'order' && last.parent === (drag.parentPath || '')) {
    last.order = order;
    // re-save (pushTreeOp persistuje, ale tady jen mutujeme — uložím ručně přes push semantics)
    // Použijeme saveTreeOps přímo. Lazy: zavoláme pushTreeOp s placeholder a hned ho odstraníme.
    // Jednodušší — duplikujeme save:
    try {
      localStorage.setItem('fakan:tree-ops', JSON.stringify(state.treeOps));
    } catch {}
  } else {
    pushTreeOp({ op: 'order', parent: drag.parentPath || '', order });
  }
  return true;
}

function onPointerMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  if (!drag.active) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    // Aktivuj drag
    drag.active = true;
    drag.suppressClick = true;
    drag.ghost = makeGhost(drag.name, drag.type);
    drag.indicator = makeIndicator();
    document.body.classList.add('is-dragging-node');
  }
  moveGhost(e.clientX, e.clientY);
  const target = pickTarget(e.clientY);
  drag.targetIndex = target.index;
  moveIndicator(target);
}

function onPointerUp(e) {
  document.removeEventListener('pointermove', onPointerMove, true);
  document.removeEventListener('pointerup', onPointerUp, true);
  if (!drag) return;
  if (!drag.active) {
    cleanup();
    return;
  }
  const newIdx = drag.targetIndex != null ? drag.targetIndex : drag.originalIndex;
  const didMove = (newIdx !== drag.originalIndex) && applyReorder(newIdx);
  cleanup();
  if (didMove) {
    rebuildMindmap(state.focusedPath, { keepViewport: true });
  }
}

function onPointerDown(e) {
  if (e.button !== 0) return;
  const hit = e.target.closest('.hit');
  if (!hit) return;
  const type = hit.dataset.type;
  if (type === 'root' || type === 'more') return;
  const path = hit.dataset.path === '/' ? '' : hit.dataset.path;
  const node = state.byPath.get(path);
  if (!node) return;
  const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const parent = findSubtree(state.originalTree, parentPath || '');
  if (!parent || !Array.isArray(parent.children) || parent.children.length < 2) return;
  const originalIndex = parent.children.findIndex((c) => c.name === node.name);
  if (originalIndex < 0) return;

  // Sourozenci jako tree-index uzly (jen ti, co jsou v aktuálně vykreslené mindmapě)
  const siblings = [];
  for (const c of parent.children) {
    const childPath = parentPath ? `${parentPath}/${c.name}` : c.name;
    const tn = state.byPath.get(childPath);
    if (tn) siblings.push(tn);
  }

  drag = {
    path,
    name: node.name,
    type: node.type,
    parentPath,
    siblings,
    originalIndex,
    startX: e.clientX,
    startY: e.clientY,
    active: false,
    suppressClick: false,
    ghost: null,
    indicator: null,
    targetIndex: originalIndex,
  };
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
}

function onClickCapture(e) {
  if (drag && drag.suppressClick) {
    e.stopPropagation();
    e.preventDefault();
    drag = null;
  }
}

export function setupDragDrop() {
  const hits = document.getElementById('hits');
  if (!hits) return;
  hits.addEventListener('pointerdown', onPointerDown);
  // Capture, aby click po dragu nedoletěl k handleHit v boot.js
  hits.addEventListener('click', onClickCapture, true);
}
