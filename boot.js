// Boot orchestrace — DOMContentLoaded sekvence.

import { state } from './state.js';
import { setupViewport, focusNode, recenter, restoreRecenterHistory, revealMore } from './mindmap.js';
import {
  renderNav, openMain, openMainOnly, openAsFollower, closePanel,
} from './panels.js';
import { setupKeyboard } from './keyboard.js';
import {
  setupDropZone, renderSourceMenu, mountBadge, renderEmptyHint, showEmptyState,
  tryRestoreSource, tryRestoreGithub, tryRestoreSnapshot, tryLoadDefaultSource,
} from './sources.js';
import { parseUrl, findNodeByPath, replaceUrl } from './url.js';

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
    // 'more' uzel = odhal další várku in-place (žádný recenter); single i dbl klik stejně
    if (el.dataset.type === 'more') {
      if (pendingSingle) { clearTimeout(pendingSingle); pendingSingle = null; }
      const target = el.dataset.targetPath || '';
      revealMore(target === '/' ? '' : target);
      return;
    }
    const node = state.byPath.get(path === '/' ? '' : path);
    if (!node) return;
    focusNode(node);
    const isDir = node.type === 'dir' || node.type === 'root';
    // dblclick: složka = recenter (otevři), soubor = openMain (nové okno)
    if (mode === 'new') {
      if (pendingSingle) { clearTimeout(pendingSingle); pendingSingle = null; }
      if (isDir) recenter(node.path || '');
      else openMain(node);
      return;
    }
    if (e.shiftKey) { openMainOnly(node); return; }
    // Cmd/Ctrl+klik = follower preview (totéž okno jako Space)
    if (e.metaKey || e.ctrlKey) { openAsFollower(node); return; }
    // plain single click (i na složku) = follower preview, odložený o 220 ms
    // kvůli dblclicku — ten recenter musí stihnout zrušit timeout výš.
    if (pendingSingle) clearTimeout(pendingSingle);
    pendingSingle = setTimeout(() => { pendingSingle = null; openAsFollower(node); }, 220);
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
    await tryLoadDefaultSource();
  })();
  restoreRecenterHistory();
  initFromUrl();
  window.addEventListener('popstate', initFromUrl);
}

// Aplikuje URL na state. Volá se při bootu i z popstate.
// Tolerantní — neznámou cestu prostě ignoruje (URL nech, user uvidí home).
//
// Trailing slash = dir-only stav (recenter, žádný panel).
// Bez slashe = file (recenter na rodiče + openMain).
function initFromUrl() {
  const { path, isDir } = parseUrl();

  // 1) prázdná cesta — návrat na home
  if (!path) {
    if (state.mainPanel) closePanel(state.mainPanel);
    if (state.currentRootPath) recenter('', { silent: true });
    return;
  }

  const node = findNodeByPath(state.originalTree, path);
  if (!node) return;

  // 2) dir-only stav (URL končí slashem nebo node je dir)
  if (isDir || node.type === 'dir' || node.type === 'root') {
    if (state.mainPanel) closePanel(state.mainPanel);
    const target = node.type === 'root' ? '' : path;
    if (state.currentRootPath !== target) recenter(target, { silent: true });
    return;
  }

  // 3) file — recenter na rodiče, openMain
  if (node.type !== 'file') return;
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  if (state.currentRootPath !== parent) recenter(parent, { silent: true });
  const fresh = state.byPath.get(path) || node;
  if (state.mainPanel && state.mainPanel.path === path) {
    focusNode(fresh);
    return;
  }
  // pokud je otevřený jiný main, zavři ho — openMain to dělá taky, ale chceme
  // se vyhnout duplikátní pushState v jeho odchodu
  openMain(fresh);
  focusNode(fresh);
  // openMain volá syncFromState (pushState). Pokud popstate dorazil ze stejné
  // URL, pushState by ji opakovat nemělo (computeUrl je deterministický).
  // Pro jistotu URL přerovnej replaceState — žádný extra history entry.
  replaceUrl(state.currentRootPath, state.mainPanel?.path || '');
}
