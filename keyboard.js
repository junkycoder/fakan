// Klávesnice: šipky tree-nav, Enter/Space/Esc, panel zkratky (Cmd+Shift+*).

import { state } from './state.js';
import { focusNode, recenter, recenterBack, recenterForwardStep } from './mindmap.js';
import {
  openMain, openMainOnly, openAsFollower,
  closePanel, toggleMax, dockPanel, bringToFront, setActive, getAllPanels,
} from './panels.js';

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
  const all = getAllPanels();
  if (!all.length) return;
  const idx = state.activePanel ? all.indexOf(state.activePanel) : -1;
  let n = (idx < 0 ? 0 : idx + direction);
  if (n < 0) n = all.length - 1;
  if (n >= all.length) n = 0;
  switchToPanel(all[n]);
}

export function setupKeyboard(_unused, vp) {
  // tree index je v state (byPath, childrenByPath, topQuadrant);
  // aktualizuje ho buildTreeIndex() volaný z bootu i z rebuildMindmap.

  const move = (current, action) => {
    if (action === 'parent') {
      const parts = (current.path || '').split('/');
      const parentPath = parts.slice(0, -1).join('/');
      // pokud rodič je nad současným virtuálním rootem, vrať virtuální root
      if (state.currentRootPath && parentPath.length < state.currentRootPath.length) {
        return state.byPath.get(state.currentRootPath);
      }
      return state.byPath.get(parentPath);
    }
    if (action === 'child') {
      const kids = state.childrenByPath.get(current.path || '') || [];
      return kids[0];
    }
    if (action === 'prevSibling' || action === 'nextSibling') {
      if (current.type === 'root') return null;
      const parts = current.path.split('/');
      const parentPath = parts.slice(0, -1).join('/');
      let sibs = state.childrenByPath.get(parentPath) || [];
      // top-level děti (rodič = currentRootPath): omezit na stejný kvadrant
      if (parentPath === state.currentRootPath) {
        const q = current.quadrant;
        sibs = sibs.filter((s) => state.topQuadrant.get(s.path) === q);
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
    const topLevels = state.childrenByPath.get(state.currentRootPath) || [];
    return topLevels.find((n) => state.topQuadrant.get(n.path) === q);
  };

  // pro běžný uzel: šipka → action podle kvadrantu. Parent action je vyhrazen
  // pro Cmd+← (snadno se zmáčkne omylem) — v EAST proto plain ← a v WEST plain →
  // nedělají parent skok.
  const QUAD_ACTIONS = {
    south: { up: 'parent', down: 'child', left: 'prevSibling', right: 'nextSibling' },
    north: { down: 'parent', up: 'child', left: 'prevSibling', right: 'nextSibling' },
    east:  { right: 'child', up: 'prevSibling', down: 'nextSibling' },
    west:  { left: 'child', up: 'prevSibling', down: 'nextSibling' },
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
        if (state.activePanel) closePanel(state.activePanel);
        return;
      }
      if (e.code === 'BracketRight') { e.preventDefault(); cycleTab(1); return; }
      if (e.code === 'BracketLeft')  { e.preventDefault(); cycleTab(-1); return; }
      if (e.code === 'KeyM') {
        e.preventDefault();
        if (state.activePanel) toggleMax(state.activePanel);
        return;
      }
      if (e.code === 'KeyN') {
        e.preventDefault();
        const node = state.byPath.get(state.focusedPath);
        if (node) openAsFollower(node);
        return;
      }
      const dm = e.code.match(/^Digit([1-9])$/);
      if (dm) {
        e.preventDefault();
        const all = getAllPanels();
        switchToPanel(all[Number(dm[1]) - 1]);
        return;
      }
      // jiné mod+shift kombinace propustíme prohlížeči
    }

    if (e.key === '0') { vp.center(); return; }

    // Shift+H/J/K/L = dock aktivního panelu (vim `<C-w>HJKL` ekvivalent).
    // Lowercase h/j/k/l jsou navigace ve stromu (řeší se níž v dirMap).
    if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const dockMap = { H: 'left', J: 'bottom', K: 'top', L: 'right' };
      if (e.key in dockMap && state.activePanel) {
        e.preventDefault();
        dockPanel(state.activePanel, dockMap[e.key]);
        return;
      }
    }

    const dirMap = {
      ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
      k: 'up', j: 'down', h: 'left', l: 'right',
    };
    if (e.key in dirMap) {
      const dir = dirMap[e.key];
      // Cmd/Ctrl + ←/→ = URL hierarchie (parent/child) napříč všemi kvadranty,
      // analogicky k browser "back/forward". Přepíše default browser back.
      // Na rootu: Cmd+← recentruje na parent (a uloží current do forward stacku),
      // Cmd+→ vrátí poslední slozku z forward stacku — jinak focus na první kid.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (dir === 'left' || dir === 'right')) {
        e.preventDefault();
        const current = state.byPath.get(state.focusedPath) || state.byPath.get('');
        if (!current) return;
        if (current.type === 'root' && state.currentRootPath) {
          if (dir === 'left') {
            const parts = state.currentRootPath.split('/');
            const parentPath = parts.slice(0, -1).join('/');
            recenterBack(parentPath);
            return;
          }
          if (recenterForwardStep()) return;
          const kids = state.childrenByPath.get(state.currentRootPath) || [];
          const k = kids[0];
          if (k) {
            focusNode(k);
            vp.ensureVisible(k);
            if (state.followerPanel) openAsFollower(k);
          }
          return;
        }
        const action = dir === 'left' ? 'parent' : 'child';
        const next = move(current, action);
        if (next) {
          focusNode(next);
          vp.ensureVisible(next);
          if (state.followerPanel) openAsFollower(next);
        }
        return;
      }
      // Cmd/Ctrl/Alt + jiné šipky = nech prohlížeči (Cmd+↑/↓, Alt+šipky apod.)
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      const current = state.byPath.get(state.focusedPath) || state.byPath.get('');
      if (!current) return;
      let next = null;
      let actionDefined = false;
      if (current.type === 'root') {
        next = goToQuadrant(rootQuadrantArrow[dir]);
        actionDefined = true;
      } else {
        const action = QUAD_ACTIONS[current.quadrant]?.[dir];
        if (action) {
          actionDefined = true;
          next = move(current, action);
        }
      }
      // fallback: když strom-akce nic nevrátí (list, konec sourozenců),
      // zkus geometricky nejbližší uzel — aby šipka nezůstávala "zaseklá".
      // Když pro daný směr žádná akce není definovaná (např. plain ← v EAST),
      // nesahej na nic — to je explicitní no-op.
      if (!next && actionDefined) next = findNeighbor(current, dir, state.treeNodes);
      if (next) {
        focusNode(next);
        vp.ensureVisible(next);
        // pokud běží follower náhled, posuň ho na nový focus
        if (state.followerPanel) openAsFollower(next);
      }
      return;
    }

    if (e.key === 'Enter') {
      const node = state.byPath.get(state.focusedPath);
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
      // bez modifieru: otevři jako main panel
      openMain(node);
      return;
    }

    if (e.key === ' ') {
      const node = state.byPath.get(state.focusedPath);
      if (node) {
        e.preventDefault();
        // adresář (i root) = recenter
        if (node.type === 'dir' || node.type === 'root') {
          recenter(node.path || '');
          return;
        }
        // druhý mezerník na stejném uzlu zavře follower
        if (state.followerPanel && state.followerPanel.path === (node.path || '/')) {
          closePanel(state.followerPanel);
        } else {
          openAsFollower(node);
        }
      }
      return;
    }

    if (e.key === 'Escape') {
      // zavře nejvyšší preview, pokud existuje, jinak main
      const lastPreview = Array.from(state.previewPanels.values()).pop();
      if (lastPreview) closePanel(lastPreview);
      else if (state.mainPanel) closePanel(state.mainPanel);
    }
  });
}
