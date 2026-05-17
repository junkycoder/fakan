// Boot orchestrace — DOMContentLoaded sekvence.

import { state } from './state.js';
import { setupViewport, focusNode, recenter } from './mindmap.js';
import {
  renderNav, openMain, openMainOnly, openPreview, openAsFollower, closePanel,
} from './panels.js';
import { setupKeyboard } from './keyboard.js';
import {
  setupDropZone, renderSourceMenu, mountBadge, renderEmptyHint, showEmptyState,
  tryRestoreSource, tryRestoreGithub, tryRestoreSnapshot, tryLoadStaticTree,
} from './sources.js';
import { urlToPath, findNodeByPath, syncUrl } from './url.js';

export async function boot() {
  const canvas = document.getElementById('canvas');
  const viewport = document.getElementById('viewport');
  const hits = document.getElementById('hits');

  // viewport — getView() je tolerantní na chybějící strom
  const vp = setupViewport(canvas, viewport, () => {
    const root = state.byPath.get(state.currentRootPath) || state.treeNodes.find((n) => n.type === 'root');
    if (!root || !state.currentBbox) return null;
    return { bb: state.currentBbox, rootNode: root };
  });
  state.viewportApi = vp;
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
    const node = state.byPath.get(path === '/' ? '' : path);
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
  await (async () => {
    if (await tryRestoreSource()) return;
    if (await tryRestoreGithub()) return;
    if (await tryRestoreSnapshot()) return;
    await tryLoadStaticTree();
  })();
  initFromUrl();
  window.addEventListener('popstate', initFromUrl);
}

// Aplikuje URL na state: recenter na rodiče souboru + openMain.
// Tolerantní — neexistující cestu nebo dir prostě ignoruje.
function initFromUrl() {
  const path = urlToPath();
  if (!path) {
    // návrat na /: zavři main panel, vrať mindmapu na home
    if (state.mainPanel) closePanel(state.mainPanel);
    if (state.currentRootPath) recenter('');
    return;
  }
  const node = findNodeByPath(state.originalTree, path);
  if (!node || node.type !== 'file') {
    // neznámá cesta nebo dir — necháme být, URL ponecháme, user uvidí home
    return;
  }
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  recenter(parent);
  const fresh = state.byPath.get(path) || node;
  // pokud už main panel sedí na cílový soubor (popstate na stejnou URL), jen refocus
  if (state.mainPanel && state.mainPanel.path === path) {
    focusNode(fresh);
    return;
  }
  openMain(fresh);
  focusNode(fresh);
  // pojistka: openMain volá syncUrl, ale pokud byl path identický, mohl by chybět
  syncUrl(path);
}
