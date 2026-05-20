// Drag & drop přesouvání uzlů v mindmapě.
//
// Architektura:
// - pointerdown na .hit aktivuje "armed" stav (zatím neběží drag)
// - pohyb > DRAG_THRESHOLD px aktivuje drag mode: ghost element, hover detection
// - během dragu udržujeme state.dragPreview = undo callback, abychom uměli
//   vrátit dočasnou modifikaci originalTree při změně targetu / cancelu
// - drop nad validním targetem: recordMove (persist do treeOps + relocate LS edits)
// - cancel (Escape, drop mimo): undo preview, rebuild

import { state, previewMove, recordMove } from './state.js';
import { rebuildMindmap, focusNode } from './mindmap.js';

const DRAG_THRESHOLD = 6; // px před aktivací dragu

let armed = null;       // { srcPath, srcEl, x, y } — pointerdown zachycen, čeká na pohyb
let dragging = null;    // aktivní drag: { srcPath, ghost, currentTarget, undo }
let suppressNextClick = false;

export function isDraggingNode() { return !!dragging; }
export function shouldSuppressClick() {
  if (suppressNextClick) { suppressNextClick = false; return true; }
  return false;
}

export function setupDragDrop() {
  const hits = document.getElementById('hits');
  if (!hits) return;

  hits.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dragging) {
      e.preventDefault();
      cancelDrag();
    }
  });
}

function onPointerDown(e) {
  if (e.button !== 0) return;
  const el = e.target.closest('.hit');
  if (!el) return;
  // root uzel přesouvat nelze
  if (el.dataset.type === 'root' || el.dataset.type === 'more') return;
  const path = el.dataset.path;
  if (!path || path === '/') return;
  armed = { srcPath: path === '/' ? '' : path, srcEl: el, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
}

function onPointerMove(e) {
  if (dragging) {
    updateGhostPosition(e.clientX, e.clientY);
    updateTarget(e.clientX, e.clientY);
    return;
  }
  if (!armed || e.pointerId !== armed.pointerId) return;
  const dx = e.clientX - armed.x;
  const dy = e.clientY - armed.y;
  if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
  startDrag(e);
}

function onPointerUp(e) {
  if (dragging) {
    finishDrag(e);
    return;
  }
  armed = null;
}

function onPointerCancel() {
  if (dragging) cancelDrag();
  armed = null;
}

function startDrag(e) {
  if (!armed) return;
  const src = state.byPath.get(armed.srcPath);
  if (!src) { armed = null; return; }

  const labelEl = document.querySelector(`#labels .n[data-node-path="${cssEscape(armed.srcPath || '/')}"]`);
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.textContent = src.name + (src.type === 'dir' ? '/' : '');
  if (labelEl) {
    const cs = getComputedStyle(labelEl);
    ghost.style.color = cs.color;
  }
  document.body.appendChild(ghost);

  dragging = {
    srcPath: armed.srcPath,
    ghost,
    currentTarget: null, // path
    undo: null,
    srcEl: armed.srcEl,
  };
  armed = null;

  // vizuální feedback na původním uzlu
  if (labelEl) labelEl.classList.add('is-dragging');
  document.body.classList.add('dnd-active');

  updateGhostPosition(e.clientX, e.clientY);
  updateTarget(e.clientX, e.clientY);
}

function updateGhostPosition(x, y) {
  if (!dragging) return;
  dragging.ghost.style.left = `${x + 12}px`;
  dragging.ghost.style.top = `${y + 12}px`;
}

function updateTarget(x, y) {
  if (!dragging) return;
  // schovat ghost při hit-testu, aby nezachycovat sám sebe
  dragging.ghost.style.pointerEvents = 'none';
  const under = document.elementFromPoint(x, y);
  const hit = under ? under.closest('.hit') : null;
  const targetPath = resolveDropTarget(hit, dragging.srcPath);

  if (targetPath === dragging.currentTarget) return;

  clearTargetHighlight();

  // undo předchozí preview (vrátí strom, ale DOM zatím odráží starý layout — rebuild níž)
  const hadPreview = !!dragging.undo;
  if (dragging.undo) {
    dragging.undo();
    dragging.undo = null;
  }

  dragging.currentTarget = null;
  let focusPath;

  if (targetPath != null) {
    const dstPath = computeDstPath(dragging.srcPath, targetPath);
    const result = previewMove(dragging.srcPath, dstPath);
    if (result) {
      dragging.undo = result.undo;
      dragging.currentTarget = targetPath;
      focusPath = dstPath;
    }
  }

  // Rebuild jen pokud byla provedena změna stromu (preview vznikl nebo zanikl).
  if (hadPreview || dragging.currentTarget != null) {
    rebuildWithFlip(focusPath);
  }
  if (dragging.currentTarget != null) highlightTarget(dragging.currentTarget);
}

// Validace a normalizace drop targetu. Vrací path cílového rodiče nebo null.
function resolveDropTarget(hitEl, srcPath) {
  if (!hitEl) return null;
  const type = hitEl.dataset.type;
  if (type !== 'dir' && type !== 'root') return null;
  let targetPath = hitEl.dataset.path === '/' ? '' : hitEl.dataset.path;
  if (targetPath === srcPath) return null;
  // descendant
  if (targetPath.startsWith(srcPath + '/')) return null;
  // současný parent — noop
  const parts = srcPath.split('/');
  parts.pop();
  if (parts.join('/') === targetPath) return null;
  // kolize jména?
  const srcName = srcPath.split('/').pop();
  const dstPath = targetPath ? `${targetPath}/${srcName}` : srcName;
  if (state.byPath.has(dstPath)) return null;
  return targetPath;
}

function computeDstPath(srcPath, dstParent) {
  const name = srcPath.split('/').pop();
  return dstParent ? `${dstParent}/${name}` : name;
}

function highlightTarget(targetPath) {
  const sel = `#hits .hit[data-path="${cssEscape(targetPath || '/')}"]`;
  const hit = document.querySelector(sel);
  if (hit) hit.classList.add('is-drop-target');
  const labelSel = `#labels .n[data-node-path="${cssEscape(targetPath || '/')}"]`;
  const label = document.querySelector(labelSel);
  if (label) label.classList.add('is-drop-target');
}

function clearTargetHighlight() {
  document.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
}

function finishDrag(e) {
  if (!dragging) return;
  const srcPath = dragging.srcPath;
  const targetPath = dragging.currentTarget;
  // mid-drag highlight zachycen v updateTarget. Pokud je targetPath !== null,
  // preview už byl aplikován na originalTree — persistujeme.
  cleanupDrag();

  if (targetPath != null) {
    suppressNextClick = true;
    const dstPath = computeDstPath(srcPath, targetPath);
    recordMove(srcPath, dstPath);
    // tree už je modifikovaný; jen znovu sestav index + URL
    rebuildMindmap(dstPath, { keepViewport: true });
    const moved = state.byPath.get(dstPath);
    if (moved) focusNode(moved);
    try { window.dispatchEvent(new CustomEvent('fakan:tree-changed')); } catch {}
  }
}

function cancelDrag() {
  if (!dragging) return;
  if (dragging.undo) {
    dragging.undo();
    rebuildWithFlip();
  }
  suppressNextClick = true;
  cleanupDrag();
}

function cleanupDrag() {
  if (!dragging) return;
  clearTargetHighlight();
  if (dragging.ghost && dragging.ghost.parentNode) dragging.ghost.parentNode.removeChild(dragging.ghost);
  document.body.classList.remove('dnd-active');
  document.querySelectorAll('.n.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
  dragging = null;
}

// Rebuild s FLIP animací: lokální pozice (style.top/left) se použijí jako
// reference, viewport scale neovlivňuje (transform je uvnitř scaled containeru).
function rebuildWithFlip(focusPath) {
  const labels = document.getElementById('labels');
  if (!labels) {
    rebuildMindmap(focusPath, { keepViewport: true });
    return;
  }
  const before = new Map();
  for (const el of labels.children) {
    const path = el.dataset.nodePath;
    if (!path) continue;
    before.set(path, { top: parseFloat(el.style.top) || 0, left: parseFloat(el.style.left) || 0 });
  }
  rebuildMindmap(focusPath, { keepViewport: true });
  // nové DOM elementy — najdi po data-node-path
  for (const el of labels.children) {
    const path = el.dataset.nodePath;
    if (!path) continue;
    const prev = before.get(path);
    if (!prev) continue;
    const cur = { top: parseFloat(el.style.top) || 0, left: parseFloat(el.style.left) || 0 };
    const dx = prev.left - cur.left;
    const dy = prev.top - cur.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => {
      el.style.transition = 'transform 220ms cubic-bezier(.2, .8, .2, 1)';
      el.style.transform = '';
    });
  }
}

function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return String(s).replace(/["\\]/g, '\\$&');
}
