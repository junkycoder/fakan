// Zdroje dat: FS Access API, upload fallback, GitHub, IndexedDB persist,
// gitignore parser, source menu, GitHub dialog, branch picker,
// empty state + drop zone + badge.

import {
  state,
  FALLBACK_PATTERNS, IDB_NAME, IDB_STORE, IDB_KEY,
  IDB_KEY_SNAPSHOT, IDB_KEY_GH, IDB_KEY_RECENT, RECENT_CAP,
  LS_EDIT_PREFIX,
  TIP_ACCOUNT, TIP_BANK, TIP_IBAN,
  splitExt, isTextFile, parseFrontmatter, escapeHtml, mediaKind,
  applyTreeOps, clearGhBaseline, gitBlobSha, saveTreeOps,
} from './state.js';
import { rebuildMindmap } from './mindmap.js';
import { closePanel, openMain, maybeOpenDefaultIndex } from './panels.js';
import { showSearchDialog } from './search.js';

// --- FS Access API: walk dropnuté / vybrané složky ---------------------------
// Funguje v Chromu / Edge / Brave. Safari + Firefox zatím FS Access API nemají.

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

// --- IndexedDB persist ------------------------------------------------------

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

// Mapování starých type hodnot na nové (backward compat pro IDB záznamy
// uložené před rename: handle→dir, snapshot→zip, github→git).
const LEGACY_TYPE = { handle: 'dir', snapshot: 'zip', github: 'git' };
function normalizeRecentEntry(e) {
  if (!e || typeof e !== 'object') return e;
  if (LEGACY_TYPE[e.type]) return { ...e, type: LEGACY_TYPE[e.type] };
  return e;
}

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
    return Array.isArray(list) ? list.map(normalizeRecentEntry) : [];
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
  if (entry.type === 'dir') return `dir:${entry.label}`;
  if (entry.type === 'git') return `git:${entry.data?.owner}/${entry.data?.repo}@${entry.data?.branch || ''}`;
  if (entry.type === 'zip') return `zip:${entry.label}`;
  return entry.label;
}

async function pushRecentSource(type, label, data) {
  const list = await idbGetRecent();
  const entry = {
    type, label, ts: Date.now(),
    data: type === 'zip' ? null : data, // zip (nahraný snapshot) trees jsou velké → nepersistujeme data
  };
  const key = recentKey(entry);
  const filtered = list.filter((it) => recentKey(it) !== key);
  filtered.unshift(entry);
  await idbSetRecent(filtered.slice(0, RECENT_CAP));
  renderSourceMenu();
}

function currentSourceKey() {
  if (state.rootHandle) return `dir:${state.rootHandle.name}`;
  if (state.githubSpec) return `git:${state.githubSpec.owner}/${state.githubSpec.repo}@${state.githubSpec.branch || ''}`;
  if (state.uploadedSnapshot) return `zip:${state.uploadedSnapshot.name}`;
  return null;
}

async function reconnectRecent(entry) {
  try {
    if (entry.type === 'git' && entry.data) {
      await connectGithub({ ...entry.data });
      return;
    }
    if (entry.type === 'dir' && entry.data) {
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
    if (entry.type === 'zip') {
      alert(`„${entry.label}" je potřeba nahrát znovu (přetáhněte složku nebo zip do okna).`);
      return;
    }
  } catch (e) {
    console.error('reconnect recent failed', e);
    alert(`Načtení selhalo: ${e.message}`);
  }
}

// --- GitHub jako zdroj ------------------------------------------------------

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
    const remaining = r.headers.get('x-ratelimit-remaining');
    const resetSec = Number(r.headers.get('x-ratelimit-reset'));
    const isRateLimit = (r.status === 403 || r.status === 429) && (remaining === '0' || r.status === 429);
    if (isRateLimit) {
      const err = new Error(spec.token
        ? 'GitHub rate limit pro tento token vyčerpaný'
        : 'GitHub rate limit pro anonymní požadavky (60/hod na IP) vyčerpaný');
      err.code = 'rate_limit';
      err.resetAt = Number.isFinite(resetSec) ? resetSec * 1000 : null;
      err.hasToken = !!spec.token;
      throw err;
    }
    const msg = r.status === 404 ? 'repo nebo větev neexistuje (zkontrolujte owner/repo)'
      : r.status === 401 ? 'token neplatný'
      : r.status === 403 ? 'GitHub odmítl (nedostatečný přístup)'
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

export function showEmptyState() {
  const overlay = document.getElementById('empty-state');
  if (overlay) overlay.hidden = false;
}

export function hideEmptyState() {
  const overlay = document.getElementById('empty-state');
  if (overlay) overlay.hidden = true;
}

function showSourceLoader(label) {
  const el = document.getElementById('src-loader');
  if (!el) return;
  const labelEl = el.querySelector('[data-src-loader-label]');
  const statusEl = el.querySelector('[data-src-loader-status]');
  if (labelEl) labelEl.textContent = label || 'Otevírám zdroj…';
  if (statusEl) statusEl.textContent = '';
  el.hidden = false;
}

function setSourceLoaderStatus(msg) {
  const el = document.getElementById('src-loader');
  if (!el) return;
  const statusEl = el.querySelector('[data-src-loader-status]');
  if (statusEl) statusEl.textContent = msg || '';
}

function hideSourceLoader() {
  const el = document.getElementById('src-loader');
  if (el) el.hidden = true;
}

function formatResetIn(ms) {
  if (!ms) return null;
  const diff = ms - Date.now();
  if (diff <= 0) return 'už teď';
  const min = Math.ceil(diff / 60000);
  if (min < 60) return `za ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `za ${h} h ${m} min` : `za ${h} h`;
}

export function renderEmptyHint(emptyState) {
  const inner = document.querySelector('[data-empty-hint]');
  if (!inner) return;
  inner.innerHTML = '';
  if (emptyState && emptyState.ghError) {
    const { error, spec, kind } = emptyState.ghError;
    const title = document.createElement('p');
    title.className = 'empty-state__title';
    title.textContent = kind === 'restore' ? 'Uložený zdroj se nepovedlo načíst' : 'Zdroj se nepovedlo načíst';
    inner.appendChild(title);

    const src = document.createElement('p');
    src.className = 'empty-state__src';
    src.textContent = `${spec.owner}/${spec.repo}${spec.branch ? `@${spec.branch}` : ''}`;
    inner.appendChild(src);

    const msg = document.createElement('p');
    msg.className = 'empty-state__err';
    let text = error?.message || 'Neznámá chyba';
    if (error?.code === 'rate_limit') {
      const when = formatResetIn(error.resetAt);
      if (when) text += ` (limit se obnoví ${when})`;
    }
    msg.textContent = text;
    inner.appendChild(msg);

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'empty-state__rest';
    retry.textContent = 'Zkusit znovu';
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      const orig = retry.textContent;
      retry.textContent = 'Zkouším…';
      try {
        await connectGithub({ ...spec });
      } catch (e) {
        renderEmptyHint({ ghError: { error: e, spec, kind } });
      } finally {
        if (retry.isConnected) { retry.disabled = false; retry.textContent = orig; }
      }
    });
    inner.appendChild(retry);

    if (error?.code === 'rate_limit' && !error.hasToken) {
      const tip = document.createElement('p');
      tip.className = 'empty-state__note';
      tip.innerHTML = 'S GitHub tokenem (přes <kbd>Zdroj</kbd> ▾ → <kbd>Připojit GitHub</kbd>) je limit 5000 volání / hod místo 60.';
      inner.appendChild(tip);
    } else {
      const tip = document.createElement('p');
      tip.className = 'empty-state__note';
      tip.innerHTML = 'Nebo zvolte jiný zdroj přes <kbd>Zdroj</kbd> ▾ v menu.';
      inner.appendChild(tip);
    }
    return;
  }
  if (emptyState && emptyState.needsPermission && emptyState.handle) {
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'empty-state__rest';
    restore.textContent = `Otevřít poslední: ${emptyState.handle.name}`;
    restore.addEventListener('click', async () => {
      try {
        const perm = await emptyState.handle.requestPermission({ mode: 'readwrite' });
        if (perm === 'granted') await loadAndMount(emptyState.handle, { persist: false });
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

export function setupDropZone() {
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

// Mount lock — zabraňuje race při paralelním přepínání zdrojů
// (dvojklik na "Připojit", přepnutí GitHub→složka během fetch atd.).
// Druhý pokus se odmítne; user dostane info, že už něco běží.
let _mountInFlight = null;

async function withMountLock(label, fn) {
  if (_mountInFlight) {
    alert(`Už připojuji „${_mountInFlight}". Počkejte na dokončení.`);
    return;
  }
  _mountInFlight = label;
  try {
    return await fn();
  } finally {
    _mountInFlight = null;
  }
}

async function loadAndMount(handle, opts = {}) {
  return withMountLock(handle.name || 'složka', async () => {
  showSourceLoader(`Otevírám ${handle.name || 'složku'}…`);
  setSourceLoaderStatus('procházím soubory…');
  try {
    const tree = await loadFromHandle(handle);
    state.rootHandle = handle;
    state.githubSpec = null;
    state.uploadedSnapshot = null;
    clearGhBaseline();
    state.originalTree = applyTreeOps(tree);
    state.currentRootPath = '';
    state.recenterHistory = [];
    hideEmptyState();
    setSourceLoaderStatus('skládám mindmapu…');
    rebuildMindmap('');
    maybeOpenDefaultIndex();
    renderSourceMenu();
    if (opts.persist !== false) await idbSetHandle(handle);
    await idbClearGithubSpec();
    await idbClearSnapshot();
    await pushRecentSource('dir', handle.name || '~', handle);
  } catch (err) {
    console.error(err);
    alert(`Načtení složky selhalo: ${err.message}`);
  } finally {
    hideSourceLoader();
  }
  });
}

async function loadAndMountSnapshot(files, opts = {}) {
  return withMountLock(opts.tree?.name || 'snapshot', async () => {
  showSourceLoader(`Otevírám ${opts.tree?.name || 'snapshot'}…`);
  setSourceLoaderStatus('procházím soubory…');
  try {
    const tree = opts.tree || await loadFromFiles(files);
    state.rootHandle = null;
    state.githubSpec = null;
    state.uploadedSnapshot = { name: tree.name };
    clearGhBaseline();
    state.originalTree = applyTreeOps(tree);
    state.currentRootPath = '';
    state.recenterHistory = [];
    hideEmptyState();
    setSourceLoaderStatus('skládám mindmapu…');
    rebuildMindmap('');
    maybeOpenDefaultIndex();
    renderSourceMenu();
    if (opts.persist !== false) await idbSetSnapshot(tree);
    await idbClearHandle();
    await idbClearGithubSpec();
    await pushRecentSource('zip', tree.name || 'zip', null);
  } catch (err) {
    console.error(err);
    alert(`Nahrání složky selhalo: ${err.message}`);
  } finally {
    hideSourceLoader();
  }
  });
}

async function connectGithub(spec, onStatus) {
  return withMountLock(`${spec.owner}/${spec.repo}`, async () => {
    const label = `Otevírám ${spec.owner}/${spec.repo}${spec.branch ? `@${spec.branch}` : ''}…`;
    showSourceLoader(label);
    const status = (m) => {
      setSourceLoaderStatus(m);
      if (onStatus) onStatus(m);
    };
    try {
      const tree = await loadFromGithub(spec, status);
      state.rootHandle = null;
      state.githubSpec = spec;
      state.uploadedSnapshot = null;
      state.originalTree = applyTreeOps(tree);
      state.currentRootPath = '';
      state.recenterHistory = [];
      hideEmptyState();
      setSourceLoaderStatus('skládám mindmapu…');
      rebuildMindmap('');
      maybeOpenDefaultIndex();
      renderSourceMenu();
      await idbSetGithubSpec(spec);
      await idbClearHandle();
      await idbClearSnapshot();
      await pushRecentSource('git', `${spec.owner}/${spec.repo}${spec.branch ? `@${spec.branch}` : ''}`, spec);
    } finally {
      hideSourceLoader();
    }
  });
}

async function disconnectSource() {
  await idbClearHandle();
  await idbClearGithubSpec();
  await idbClearSnapshot();
  state.rootHandle = null;
  state.githubSpec = null;
  state.uploadedSnapshot = null;
  state.originalTree = null;
  state.currentRootPath = '';
  state.recenterHistory = [];
  state.treeNodes = [];
  state.currentBbox = null;
  clearGhBaseline();
  state.byPath.clear();
  state.childrenByPath.clear();
  state.topQuadrant.clear();
  // zavřít všechny panely
  if (state.mainPanel) closePanel(state.mainPanel);
  for (const p of Array.from(state.previewPanels.values())) closePanel(p);
  // smazat render
  const map = document.getElementById('map');
  const labels = document.getElementById('labels');
  const hits = document.getElementById('hits');
  if (map) map.textContent = '';
  if (labels) labels.innerHTML = '';
  if (hits) hits.innerHTML = '';
  if (state.routeNavListener) state.routeNavListener();
  renderEmptyHint(null);
  showEmptyState();
  renderSourceMenu();
}

export async function tryRestoreSource() {
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

export async function tryRestoreGithub() {
  const spec = await idbGetGithubSpec();
  if (!spec || !spec.owner || !spec.repo) return false;
  try {
    await connectGithub({ ...spec });
    return true;
  } catch (e) {
    console.warn('restore github failed', e);
    return { error: e, spec, kind: 'restore' };
  }
}

export async function tryRestoreSnapshot() {
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

// Default fallback — pokud uživatel nemá žádný zdroj v IDB, načti repo
// nakonfigurované přes <meta name="fakan-default-source"> v index.html.
// Formát hodnoty: "github:owner/repo[@branch]". Per-doména si přepíše
// meta tag deploy-specific index.htmlem.
export async function tryLoadDefaultSource() {
  const spec = readDefaultSourceMeta();
  if (!spec) return false;
  try {
    await connectGithub(spec);
    return true;
  } catch (e) {
    console.warn('default source load failed', e);
    return { error: e, spec, kind: 'default' };
  }
}

function readDefaultSourceMeta() {
  const el = document.querySelector('meta[name="fakan-default-source"]');
  const raw = el?.getAttribute('content')?.trim();
  if (!raw) return null;
  const m = raw.match(/^github:([^/\s]+)\/([^@\s]+)(?:@(.+))?$/);
  if (!m) {
    console.warn('fakan-default-source: očekávám github:owner/repo[@branch], dostal jsem', raw);
    return null;
  }
  return { owner: m[1], repo: m[2], branch: m[3] || '' };
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
      <div class="gh-dialog__field gh-dialog__field--combo">
        <span>Repo</span>
        <div class="gh-combo" data-gh-combo>
          <input type="text" data-gh-repo placeholder="jméno repa, owner/repo, URL nebo ze seznamu" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
          <div class="gh-combo__list" data-gh-list hidden></div>
        </div>
      </div>
      <label class="gh-dialog__field">
        <span>Větev <em>(volitelně)</em></span>
        <input type="text" data-gh-branch placeholder="default branch" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
      </label>
      <label class="gh-dialog__field">
        <span>Token <em>(volitelně, pro privátní repo)</em></span>
        <input type="password" data-gh-token placeholder="ghp_… / github_pat_…" autocomplete="off" spellcheck="false">
      </label>
      <p class="gh-dialog__hint">Token zůstane jen lokálně v IndexedDB tohohle prohlížeče. S tokenem se v nabídce objeví i vaše repa. <a href="https://github.com/settings/tokens/new?description=fakan&amp;scopes=repo" target="_blank" rel="noopener noreferrer">Vygenerovat token</a>.</p>
      <div class="gh-dialog__status" data-gh-status></div>
      <div class="gh-dialog__buttons">
        <button type="button" class="gh-dialog__btn" data-gh-cancel>Zrušit</button>
        <button type="button" class="gh-dialog__btn gh-dialog__btn--primary" data-gh-ok>Připojit</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  const repoIn = wrap.querySelector('[data-gh-repo]');
  const listEl = wrap.querySelector('[data-gh-list]');
  const branchIn = wrap.querySelector('[data-gh-branch]');
  const tokenIn = wrap.querySelector('[data-gh-token]');
  const okBtn = wrap.querySelector('[data-gh-ok]');
  const cancelBtn = wrap.querySelector('[data-gh-cancel]');
  const statusEl = wrap.querySelector('[data-gh-status]');

  // --- combobox stav --------------------------------------------------------
  let recentEntries = [];   // [{owner, repo, branch, token}]
  let myRepos = null;       // null = nenačteno; pole = výsledek
  let myReposLoading = false;
  let myReposError = null;
  let activeToken = null;   // token, kterým byly načtené myRepos
  let myLogin = null;       // login z /user pro aktuální token
  let currentItems = [];    // momentálně vykreslené (vč. headers)
  let highlightIdx = -1;

  const tokenForFetch = () => {
    const fromInput = tokenIn.value.trim();
    if (fromInput) return fromInput;
    if (state.githubSpec?.token) return state.githubSpec.token;
    const fromRecent = recentEntries.find((e) => e.token);
    return fromRecent?.token || null;
  };

  const loadMyRepos = async () => {
    const tk = tokenForFetch();
    if (!tk || myReposLoading) return;
    if (activeToken === tk && (myRepos !== null || myReposError)) return;
    activeToken = tk;
    myReposLoading = true;
    myReposError = null;
    renderList();
    try {
      const repos = [];
      for (let page = 1; page <= 3; page++) {
        const r = await fetch(`https://api.github.com/user/repos?per_page=100&sort=pushed&page=${page}`, {
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${tk}` },
        });
        if (!r.ok) {
          if (r.status === 401) throw new Error('token neplatný');
          if (r.status === 403) throw new Error('rate limit nebo přístup odmítnut');
          throw new Error(`GitHub ${r.status}`);
        }
        const data = await r.json();
        if (!Array.isArray(data) || !data.length) break;
        for (const d of data) {
          if (d?.owner?.login && d?.name) repos.push({
            owner: d.owner.login,
            repo: d.name,
            branch: d.default_branch || '',
            private: !!d.private,
            description: d.description || '',
          });
        }
        if (data.length < 100) break;
      }
      myRepos = repos;
      loadMyLogin(tk);
    } catch (err) {
      myReposError = err.message;
      myRepos = [];
    } finally {
      myReposLoading = false;
      renderList();
    }
  };

  const loadMyLogin = async (tk) => {
    if (!tk || myLogin) return;
    try {
      const r = await fetch('https://api.github.com/user', {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${tk}` },
      });
      if (!r.ok) return;
      const d = await r.json();
      if (d?.login) myLogin = d.login;
    } catch {}
  };

  const renderList = () => {
    const q = repoIn.value.trim().toLowerCase();
    const matchQ = (e) => !q || `${e.owner}/${e.repo}`.toLowerCase().includes(q);
    const items = [];

    const recent = recentEntries.filter(matchQ);
    if (recent.length) {
      items.push({ kind: 'header', label: 'Nedávné' });
      for (const e of recent) items.push({ kind: 'recent', data: e });
    }

    if (myRepos === null && tokenForFetch() && !myReposLoading) {
      loadMyRepos();
    }
    if (myReposLoading) {
      items.push({ kind: 'header', label: 'Moje repa' });
      items.push({ kind: 'status', label: 'načítám…' });
    } else if (myReposError) {
      items.push({ kind: 'header', label: 'Moje repa' });
      items.push({ kind: 'status', label: myReposError });
    } else if (Array.isArray(myRepos) && myRepos.length) {
      const recentKeys = new Set(recent.map((r) => `${r.owner}/${r.repo}`));
      const mine = myRepos.filter(matchQ).filter((r) => !recentKeys.has(`${r.owner}/${r.repo}`));
      if (mine.length) {
        items.push({ kind: 'header', label: 'Moje repa' });
        for (const r of mine.slice(0, 40)) items.push({ kind: 'mine', data: r });
      }
    }

    currentItems = items;
    if (highlightIdx >= 0 && (highlightIdx >= items.length || (items[highlightIdx]?.kind !== 'recent' && items[highlightIdx]?.kind !== 'mine'))) {
      highlightIdx = -1;
    }

    if (!items.length) {
      listEl.hidden = true;
      listEl.innerHTML = '';
      return;
    }
    listEl.hidden = false;
    listEl.innerHTML = items.map((it, i) => {
      if (it.kind === 'header') return `<div class="gh-combo__header">${escapeHtml(it.label)}</div>`;
      if (it.kind === 'status') return `<div class="gh-combo__status">${escapeHtml(it.label)}</div>`;
      const e = it.data;
      const label = `${e.owner}/${e.repo}`;
      let sub = '';
      if (it.kind === 'recent' && e.branch) sub = `@${e.branch}`;
      else if (it.kind === 'mine' && e.private) sub = 'private';
      else if (it.kind === 'mine' && e.description) sub = e.description;
      const icon = it.kind === 'recent' ? '⏱' : '★';
      const cls = `gh-combo__item${i === highlightIdx ? ' is-active' : ''}`;
      return `<button type="button" class="${cls}" data-idx="${i}">
        <span class="gh-combo__icon" aria-hidden="true">${icon}</span>
        <span class="gh-combo__label">${escapeHtml(label)}</span>
        ${sub ? `<span class="gh-combo__sub">${escapeHtml(sub)}</span>` : ''}
      </button>`;
    }).join('');
    listEl.querySelectorAll('[data-idx]').forEach((btn) => {
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => pickItem(parseInt(btn.dataset.idx, 10)));
    });
  };

  const pickItem = (i) => {
    const it = currentItems[i];
    if (!it || (it.kind !== 'recent' && it.kind !== 'mine')) return;
    const e = it.data;
    repoIn.value = `${e.owner}/${e.repo}`;
    if (it.kind === 'recent') {
      if (e.branch) branchIn.value = e.branch;
      if (e.token && !tokenIn.value) tokenIn.value = e.token;
    } else if (it.kind === 'mine' && e.branch && !branchIn.value) {
      // default branch z API nevyplňujeme — uživatel ji většinou nechce vidět;
      // necháme prázdnou aby connectGithub zvolil default.
    }
    listEl.hidden = true;
    highlightIdx = -1;
    okBtn.focus();
  };

  // --- vstupy ---------------------------------------------------------------
  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      if (!listEl.hidden) { listEl.hidden = true; highlightIdx = -1; e.preventDefault(); return; }
      e.preventDefault(); close(); return;
    }
    if (e.key === 'Enter' && !okBtn.disabled && document.activeElement !== repoIn) {
      e.preventDefault(); submit();
    }
  };
  document.addEventListener('keydown', onKey);
  cancelBtn.addEventListener('click', close);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });

  repoIn.addEventListener('focus', () => renderList());
  repoIn.addEventListener('input', () => { highlightIdx = -1; renderList(); });
  repoIn.addEventListener('blur', () => {
    setTimeout(() => { listEl.hidden = true; }, 120);
  });
  repoIn.addEventListener('keydown', (e) => {
    const navIdxs = currentItems
      .map((it, i) => (it.kind === 'recent' || it.kind === 'mine') ? i : -1)
      .filter((i) => i >= 0);
    if (e.key === 'ArrowDown' && navIdxs.length) {
      e.preventDefault();
      if (listEl.hidden) { renderList(); }
      const cur = navIdxs.indexOf(highlightIdx);
      highlightIdx = navIdxs[(cur + 1) % navIdxs.length];
      renderList();
      scrollHighlightIntoView();
    } else if (e.key === 'ArrowUp' && navIdxs.length) {
      e.preventDefault();
      const cur = navIdxs.indexOf(highlightIdx);
      highlightIdx = navIdxs[cur <= 0 ? navIdxs.length - 1 : cur - 1];
      renderList();
      scrollHighlightIntoView();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightIdx >= 0) pickItem(highlightIdx);
      else if (!okBtn.disabled) submit();
    } else if (e.key === 'Tab') {
      listEl.hidden = true;
    }
  });

  const scrollHighlightIntoView = () => {
    const active = listEl.querySelector('.gh-combo__item.is-active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  };

  tokenIn.addEventListener('input', () => {
    const v = tokenIn.value.trim();
    if (v && v !== activeToken) {
      myRepos = null; myReposError = null; activeToken = null; myLogin = null;
      if (document.activeElement === repoIn) renderList();
    }
  });

  const submit = async () => {
    const raw = repoIn.value.trim();
    let parsed = parseRepoInput(raw);
    if (!parsed && /^[\w.-]+$/.test(raw)) {
      const ownerGuess = myLogin || recentEntries[0]?.owner || null;
      if (ownerGuess) parsed = { owner: ownerGuess, repo: raw, branch: '' };
    }
    if (!parsed) {
      statusEl.textContent = 'Zadejte jméno repa, owner/repo nebo URL.';
      statusEl.dataset.kind = 'err';
      repoIn.focus();
      return;
    }
    const spec = { ...parsed };
    const br = branchIn.value.trim();
    const tk = tokenIn.value.trim() || tokenForFetch();
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

  // bootstrap: nedávné GH repa z historie
  idbGetRecent().then((list) => {
    const ghs = list.filter((e) => e.type === 'git' && e.data?.owner && e.data?.repo);
    recentEntries = ghs.map((e) => ({
      owner: e.data.owner,
      repo: e.data.repo,
      branch: e.data.branch || '',
      token: e.data.token || '',
    }));
    if (document.activeElement === repoIn) renderList();
  }).catch(() => {});

  setTimeout(() => { repoIn.focus(); renderList(); }, 0);
}


// --- Export: mini ZIP encoder (stored, bez deflate) -------------------------

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date) {
  const d = date || new Date();
  const dosTime = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() >>> 1) & 0x1F);
  const yr = Math.max(1980, d.getFullYear());
  const dosDate = (((yr - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0xF) << 5) | (d.getDate() & 0x1F);
  return { dosTime, dosDate };
}

// entries: [{ path: string, data: Uint8Array, mtime?: Date }]
function buildZipBlob(entries) {
  const enc = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = enc.encode(e.path);
    const crc = crc32(e.data);
    const size = e.data.length;
    const { dosTime, dosDate } = dosDateTime(e.mtime);
    const lfh = new Uint8Array(30);
    const lv = new DataView(lfh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 flag
    lv.setUint16(8, 0, true);      // store
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.push(lfh, nameBytes, e.data);

    const cdh = new Uint8Array(46);
    const cv = new DataView(cdh.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.push(cdh, nameBytes);

    offset += 30 + nameBytes.length + size;
  }
  const cdStart = offset;
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  ev.setUint16(20, 0, true);
  return new Blob([...local, ...central, eocd], { type: 'application/zip' });
}

function loadEditOverrideByPath(path) {
  if (!path) return null;
  try { return localStorage.getItem(LS_EDIT_PREFIX + path); } catch { return null; }
}

function collectEditOverlayKeys() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_EDIT_PREFIX)) out.push(k);
    }
  } catch {}
  return out;
}

// --- FS write-back ---------------------------------------------------------
// Uloží lokální edity (LS overlay + state.treeOps) zpět na disk přes File
// System Access API. Funguje jen když je připojený state.rootHandle (typ 'dir').

export function hasLocalDirChanges() {
  if (!state.rootHandle) return false;
  if (state.treeOps && state.treeOps.length) return true;
  return collectEditOverlayKeys().length > 0;
}

async function resolveDirHandle(root, segments, { create = false } = {}) {
  let cur = root;
  for (const seg of segments) {
    if (!seg) continue;
    cur = await cur.getDirectoryHandle(seg, { create });
  }
  return cur;
}

async function resolveFileHandle(root, path, { create = false } = {}) {
  const parts = path.split('/').filter(Boolean);
  if (!parts.length) throw new Error('prázdná cesta');
  const name = parts.pop();
  const dir = await resolveDirHandle(root, parts, { create });
  return dir.getFileHandle(name, { create });
}

async function writeToFileHandle(fileHandle, text) {
  const w = await fileHandle.createWritable();
  try { await w.write(text); }
  finally { await w.close(); }
}

// Sesbírá přehled změn (pro dialog před uložením). Bez side-effects.
export function collectDirChangesSummary() {
  const adds = [];     // { path, kind: 'file'|'dir' } - nově vytvořené přes treeOps
  const removes = [];  // { path } - smazané přes treeOps
  const mods = [];     // { path } - LS edit overlay
  for (const op of state.treeOps || []) {
    if (op.op === 'rm') removes.push({ path: op.path });
    else if (op.op === 'add') {
      const full = ((op.parent || '').split('/').filter(Boolean)).concat([op.name]).join('/');
      adds.push({ path: full, kind: op.isDir ? 'dir' : 'file' });
    }
  }
  const addPaths = new Set(adds.filter((a) => a.kind === 'file').map((a) => a.path));
  for (const key of collectEditOverlayKeys()) {
    const path = key.slice(LS_EDIT_PREFIX.length);
    if (!path || addPaths.has(path)) continue; // nová stuff jde do adds
    mods.push({ path });
  }
  return { adds, removes, mods };
}

// Vrací { written, removed, dirsCreated, errors[] }
export async function saveLocalEditsToFS({ onStatus } = {}) {
  const root = state.rootHandle;
  if (!root) throw new Error('Není připojená lokální složka.');
  const status = (m) => { if (onStatus) onStatus(m); };

  let written = 0;
  let removed = 0;
  let dirsCreated = 0;
  const errors = [];

  // 1) treeOps: 'rm' (mažeme nejdřív kvůli možnému re-create se stejným jménem)
  const ops = (state.treeOps || []).slice();
  for (const op of ops.filter((o) => o.op === 'rm')) {
    try {
      const parts = (op.path || '').split('/').filter(Boolean);
      const name = parts.pop();
      if (!name) continue;
      status(`mažu ${op.path}`);
      const parent = await resolveDirHandle(root, parts, { create: false });
      await parent.removeEntry(name, { recursive: true });
      removed++;
    } catch (e) {
      if (e.name === 'NotFoundError') { removed++; continue; }
      errors.push({ path: op.path, op: 'rm', err: e.message });
    }
  }

  // 2) treeOps: 'add' isDir=true (prázdné adresáře)
  for (const op of ops.filter((o) => o.op === 'add' && o.isDir)) {
    const full = ((op.parent || '').split('/').filter(Boolean)).concat([op.name]);
    try {
      status(`vytvářím adresář ${full.join('/')}`);
      await resolveDirHandle(root, full, { create: true });
      dirsCreated++;
    } catch (e) {
      errors.push({ path: full.join('/'), op: 'mkdir', err: e.message });
    }
  }

  // 3) LS edit overlay → write na disk
  const keys = collectEditOverlayKeys();
  for (const key of keys) {
    const path = key.slice(LS_EDIT_PREFIX.length);
    if (!path) continue;
    let text;
    try { text = localStorage.getItem(key); } catch { continue; }
    if (text == null) continue;
    status(`zapisuji ${path}`);

    const node = state.byPath.get(path);
    let handle = node && node._handle && typeof node._handle.createWritable === 'function' ? node._handle : null;
    if (!handle) {
      try {
        handle = await resolveFileHandle(root, path, { create: true });
      } catch (e) {
        errors.push({ path, op: 'write', err: e.message });
        continue;
      }
    }
    try {
      await writeToFileHandle(handle, text);
      if (node) {
        node._handle = handle;
        node._originalRaw = text;
      }
      try { localStorage.removeItem(key); } catch {}
      written++;
    } catch (e) {
      errors.push({ path, op: 'write', err: e.message });
    }
  }

  // 4) treeOps: 'add' isDir=false bez overlay (prázdný soubor) — vzácné
  const overlayKeySet = new Set(keys);
  for (const op of ops.filter((o) => o.op === 'add' && !o.isDir)) {
    const full = ((op.parent || '').split('/').filter(Boolean)).concat([op.name]).join('/');
    if (overlayKeySet.has(LS_EDIT_PREFIX + full)) continue; // zapsáno v kroku 3
    try {
      const h = await resolveFileHandle(root, full, { create: true });
      await writeToFileHandle(h, '');
      const n = state.byPath.get(full);
      if (n) { n._handle = h; n._originalRaw = ''; }
      written++;
    } catch (e) {
      errors.push({ path: full, op: 'touch', err: e.message });
    }
  }

  // 5) clear treeOps (jen pokud vše prošlo) — částečný úspěch nech overlay/ops,
  // ať uživatel může opakovat a vidět, co se nepodařilo
  if (!errors.length) {
    state.treeOps = [];
    saveTreeOps([]);
  }

  try { window.dispatchEvent(new CustomEvent('fakan:tree-changed')); } catch {}
  return { written, removed, dirsCreated, errors };
}

async function readNodeBytes(node, path) {
  const override = loadEditOverrideByPath(path);
  if (override != null) return new TextEncoder().encode(override);
  if (typeof node.raw === 'string') return new TextEncoder().encode(node.raw);
  if (typeof node.content === 'string') return new TextEncoder().encode(node.content);
  if (node._file && typeof node._file.arrayBuffer === 'function') {
    try { return new Uint8Array(await node._file.arrayBuffer()); } catch {}
  }
  if (node._handle && typeof node._handle.getFile === 'function') {
    try {
      const f = await node._handle.getFile();
      return new Uint8Array(await f.arrayBuffer());
    } catch {}
  }
  return null;
}

function nodeSeg(n) { return n.type === 'file' ? (n.filename || n.name) : n.name; }

async function collectExportEntries(tree, rootPrefix) {
  const out = [];
  const visit = async (node, prefix) => {
    if (!node) return;
    if (node.type === 'dir') {
      if (node.children) {
        for (const c of node.children) {
          const seg = nodeSeg(c);
          const next = prefix ? `${prefix}/${seg}` : seg;
          await visit(c, next);
        }
      }
      return;
    }
    if (node.type === 'file') {
      const data = await readNodeBytes(node, prefix);
      if (data) out.push({ path: rootPrefix ? `${rootPrefix}/${prefix}` : prefix, data });
    }
  };
  if (tree?.children) {
    for (const c of tree.children) await visit(c, nodeSeg(c));
  }
  return out;
}

function sanitizeFilename(s) {
  return String(s || 'fakan').replace(/[\\/:*?"<>|]+/g, '_').replace(/^[\s.]+|[\s.]+$/g, '') || 'fakan';
}

async function exportAsZip() {
  const tree = state.originalTree;
  if (!tree) { alert('Není co exportovat.'); return; }
  const rawName = state.rootHandle?.name
    || state.uploadedSnapshot?.name
    || state.githubSpec?.repo
    || tree.name
    || 'fakan';
  const safeName = sanitizeFilename(rawName);
  let entries;
  try {
    entries = await collectExportEntries(tree, safeName);
  } catch (e) {
    console.error('export collect failed', e);
    alert(`Export selhal: ${e.message}`);
    return;
  }
  if (!entries.length) { alert('Nic k exportu — strom je prázdný.'); return; }
  const blob = buildZipBlob(entries);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// --- Export: GitHub push ----------------------------------------------------

function bytesToBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(s);
}

// Sesbírá soubory, které se liší od posledního baselinu z GitHubu, plus add/delete.
// Vrací entries `{ path, kind, data? }` kde kind ∈ {'add', 'mod', 'del'}.
// Pro 'del' chybí `data`. Pokud baseline neexistuje (jiný zdroj než GitHub),
// vrací prázdné pole — Publish dialog se stejně nezobrazuje bez githubSpec.
async function collectGithubPushFiles(tree) {
  if (!tree || !state.ghBaselineKey) return [];
  const enc = new TextEncoder();
  const candidates = [];
  const seen = new Set();

  const visit = (node, prefix) => {
    if (!node) return;
    if (node.type === 'dir') {
      if (node.children) for (const c of node.children) {
        const seg = nodeSeg(c);
        visit(c, prefix ? `${prefix}/${seg}` : seg);
      }
      return;
    }
    if (node.type !== 'file') return;
    const [stem, ext] = splitExt(node.filename || node.name || '');
    if (!isTextFile(node.filename || node.name || '', ext)) return;
    seen.add(prefix);
    const override = loadEditOverrideByPath(prefix);
    const text = override != null ? override : (typeof node.raw === 'string' ? node.raw : null);
    if (text == null) return; // binárka / nestáhnuté — neumíme diffovat ani pushnout
    candidates.push({ path: prefix, text });
  };
  if (tree.children) for (const c of tree.children) visit(c, nodeSeg(c));

  // SHA spočti paralelně (limit kvůli velkým stromům)
  const out = [];
  await pLimitAll(candidates.map((cand) => async () => {
    const sha = await gitBlobSha(cand.text);
    const baseSha = state.ghBaselineSha.get(cand.path);
    if (baseSha == null) {
      out.push({ path: cand.path, kind: 'add', data: enc.encode(cand.text) });
    } else if (baseSha !== sha) {
      out.push({ path: cand.path, kind: 'mod', data: enc.encode(cand.text) });
    }
  }), 8);

  // smazané: byly v baselinu, ale v aktuálním stromě už nejsou
  for (const p of state.ghBaselinePaths) {
    if (!seen.has(p)) out.push({ path: p, kind: 'del' });
  }

  // deterministicky setřídit podle cesty kvůli stabilnímu UI
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

async function ghPush(spec, message, files, onStatus) {
  const note = (m) => { if (onStatus) onStatus(m); };
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
    ...ghAuthHeaders(spec),
  };
  const base = `https://api.github.com/repos/${spec.owner}/${spec.repo}`;
  const br = encodeURIComponent(spec.branch || 'main');

  note('načítám aktuální ref…');
  const refRes = await fetch(`${base}/git/refs/heads/${br}`, { headers });
  if (!refRes.ok) {
    if (refRes.status === 404) throw new Error('větev neexistuje');
    if (refRes.status === 401) throw new Error('token neplatný');
    if (refRes.status === 403) throw new Error('chybí oprávnění (token bez repo scope?)');
    throw new Error(`ref ${refRes.status}`);
  }
  const ref = await refRes.json();
  const baseSha = ref.object.sha;

  const commitRes = await fetch(`${base}/git/commits/${baseSha}`, { headers });
  if (!commitRes.ok) throw new Error(`commit ${commitRes.status}`);
  const baseCommit = await commitRes.json();
  const baseTreeSha = baseCommit.tree.sha;

  const tree = [];
  const uploadedSha = new Map();   // path -> nový blob SHA (pro update baselinu)
  const uploadCount = files.filter((f) => f.kind !== 'del').length;
  let done = 0;
  for (const f of files) {
    if (f.kind === 'del') {
      // GitHub maže entry, pokud v tree pošleme `sha: null` v kombinaci s base_tree
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    note(`nahrávám blob ${done + 1}/${uploadCount}: ${f.path}`);
    const r = await fetch(`${base}/git/blobs`, {
      method: 'POST', headers,
      body: JSON.stringify({ content: bytesToBase64(f.data), encoding: 'base64' }),
    });
    if (!r.ok) {
      if (r.status === 403) throw new Error('token nemá zápis (potřeba repo scope / contents: write)');
      throw new Error(`blob ${r.status} u ${f.path}`);
    }
    const blob = await r.json();
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    uploadedSha.set(f.path, blob.sha);
    done++;
  }

  note('sestavuji tree…');
  const treeRes = await fetch(`${base}/git/trees`, {
    method: 'POST', headers,
    body: JSON.stringify({ base_tree: baseTreeSha, tree }),
  });
  if (!treeRes.ok) throw new Error(`tree ${treeRes.status}`);
  const newTree = await treeRes.json();
  if (newTree.sha === baseTreeSha) return { unchanged: true };

  note('vytvářím commit…');
  const newCommitRes = await fetch(`${base}/git/commits`, {
    method: 'POST', headers,
    body: JSON.stringify({ message, tree: newTree.sha, parents: [baseSha] }),
  });
  if (!newCommitRes.ok) throw new Error(`commit create ${newCommitRes.status}`);
  const newCommit = await newCommitRes.json();

  note('posouvám větev…');
  const patchRes = await fetch(`${base}/git/refs/heads/${br}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ sha: newCommit.sha }),
  });
  if (!patchRes.ok) throw new Error(`ref patch ${patchRes.status}`);

  // Promítni změny do baselinu, ať další otevření dialogu ukáže „žádné změny",
  // dokud uživatel znovu něco needituje. Aktualizuj jen pokud baseline patří
  // ke stejnému (owner/repo@branch).
  const baselineKey = `${spec.owner}/${spec.repo}@${spec.branch || 'main'}`;
  if (state.ghBaselineKey === baselineKey) {
    for (const f of files) {
      if (f.kind === 'del') {
        state.ghBaselineSha.delete(f.path);
        state.ghBaselinePaths.delete(f.path);
      } else {
        const sha = uploadedSha.get(f.path);
        if (sha) state.ghBaselineSha.set(f.path, sha);
        state.ghBaselinePaths.add(f.path);
      }
    }
  }

  return { sha: newCommit.sha, unchanged: false };
}

function renderPublishButton() {
  const wrap = document.querySelector('[data-nav-publish]');
  if (!wrap) return;
  const hasSource = !!(state.rootHandle || state.githubSpec || state.uploadedSnapshot);
  if (!hasSource) {
    wrap.setAttribute('hidden', '');
    return;
  }

  const btn = wrap.querySelector('[data-publish-btn]');
  const glyph = wrap.querySelector('[data-publish-glyph]');
  const label = wrap.querySelector('[data-publish-label]');

  if (state.githubSpec) {
    glyph.textContent = '↑';
    label.textContent = 'Publish';
    btn.setAttribute('aria-label', `Publish do ${state.githubSpec.owner}/${state.githubSpec.repo}`);
    // GitHub: tlačítko zobrazuj jen pokud jsou změny vůči baselinu
    // (refreshPublishVisibility doplní viditelnost asynchronně).
    if (state.ghHasChanges === false) wrap.setAttribute('hidden', '');
    else wrap.removeAttribute('hidden');
  } else if (state.rootHandle) {
    glyph.textContent = '↑';
    label.textContent = 'Uložit';
    btn.setAttribute('aria-label', `Uložit změny do ${state.rootHandle.name}`);
    // dir: tlačítko jen když jsou nějaké LS edity / treeOps
    if (hasLocalDirChanges()) wrap.removeAttribute('hidden');
    else wrap.setAttribute('hidden', '');
  } else {
    glyph.textContent = '↓';
    label.textContent = 'Stáhnout';
    btn.setAttribute('aria-label', 'Stáhnout jako ZIP');
    wrap.removeAttribute('hidden');
  }

  if (!btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => showPublishDialog());
  }

  // pro GitHub spusť async kontrolu změn (debounced)
  if (state.githubSpec) scheduleChangesCheck();
}

// --- Publish: refresh viditelnosti podle diffu vůči GitHub baselinu ----------

let _changesCheckTimer = null;
let _changesCheckRunning = false;
function scheduleChangesCheck() {
  if (_changesCheckTimer) clearTimeout(_changesCheckTimer);
  _changesCheckTimer = setTimeout(() => { _changesCheckTimer = null; runChangesCheck(); }, 250);
}
async function runChangesCheck() {
  if (_changesCheckRunning) { scheduleChangesCheck(); return; }
  if (!state.githubSpec || !state.ghBaselineKey || !state.originalTree) return;
  _changesCheckRunning = true;
  try {
    const files = await collectGithubPushFiles(state.originalTree);
    state.ghHasChanges = files.length > 0;
    const wrap = document.querySelector('[data-nav-publish]');
    if (wrap && state.githubSpec) {
      if (state.ghHasChanges) wrap.removeAttribute('hidden');
      else wrap.setAttribute('hidden', '');
    }
  } catch (e) {
    // při chybě nech tlačítko viditelné — uživatel si může otevřít dialog a vidět chybu
    state.ghHasChanges = true;
    const wrap = document.querySelector('[data-nav-publish]');
    if (wrap && state.githubSpec) wrap.removeAttribute('hidden');
  } finally {
    _changesCheckRunning = false;
  }
}

// Veřejná funkce — volat po editu / vytvoření / smazání souboru, ať se viditelnost
// Publish/Uložit tlačítka průběžně aktualizuje.
export function refreshPublishVisibility() {
  if (state.githubSpec) { scheduleChangesCheck(); return; }
  if (state.rootHandle) { renderPublishButton(); return; }
}

// Posloucháme strom-mutující události z editoru / MC / shellu (mimo modul,
// aby nevznikla cyklická závislost).
window.addEventListener('fakan:tree-changed', () => {
  refreshPublishVisibility();
});

// --- Mobile srcbar collapse ------------------------------------------------
// Na úzkém viewportu se srcbar default zabalí do malého „zdroj" tlačítka.
// Tap rozbalí (`.is-open`), focusout / tap mimo zabalí.
function mountSrcbarToggle() {
  const bar = document.getElementById('srcbar');
  if (!bar || bar.dataset.boundToggle) return;
  bar.dataset.boundToggle = '1';

  const toggle = bar.querySelector('[data-srcbar-toggle]');
  if (!toggle) return;

  const open = () => {
    bar.classList.add('is-open');
    toggle.setAttribute('aria-expanded', 'true');
    // dej focus na první akční prvek, ať focusout funguje konzistentně
    const focusTarget = bar.querySelector('.srcbar__source-btn');
    focusTarget?.focus({ preventScroll: true });
  };
  const close = () => {
    bar.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
    // zavři i případně otevřené dropdowny
    bar.querySelectorAll('.is-open').forEach((el) => { if (el !== bar) el.classList.remove('is-open'); });
  };

  toggle.addEventListener('click', (e) => {
    e.preventDefault();
    if (bar.classList.contains('is-open')) close(); else open();
  });

  // Klik mimo srcbar = zabalit
  document.addEventListener('pointerdown', (e) => {
    if (!bar.classList.contains('is-open')) return;
    if (bar.contains(e.target)) return;
    close();
  });

  // focusout (Tab pryč) = zabalit, pokud focus skutečně opouští bar
  bar.addEventListener('focusout', (e) => {
    if (!bar.classList.contains('is-open')) return;
    const next = e.relatedTarget;
    if (next && bar.contains(next)) return;
    // malé zpoždění, aby případný klik na dropdown item nedal zavřít před akcí
    setTimeout(() => {
      if (!bar.contains(document.activeElement)) close();
    }, 0);
  });

  // Esc zabalí
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!bar.classList.contains('is-open')) return;
    close();
    toggle.focus({ preventScroll: true });
  });
}

// --- Branch picker v top-left srcbaru -------------------------------------
function renderBranchPicker() {
  const wrap = document.querySelector('[data-nav-branch]');
  if (!wrap) return;
  const spec = state.githubSpec;
  if (!spec) {
    wrap.setAttribute('hidden', '');
    return;
  }
  wrap.removeAttribute('hidden');

  const label = wrap.querySelector('[data-branch-label]');
  const menu = wrap.querySelector('[data-branch-menu]');
  const btn = wrap.querySelector('[data-branch-btn]');
  const current = spec.branch || 'main';
  if (label) label.textContent = current;
  if (btn) btn.setAttribute('aria-label', `Větev: ${current}`);
  if (!menu) return;

  // Placeholder, dokud nedoběhne API
  menu.innerHTML = '';
  const loading = document.createElement('div');
  loading.className = 'srcbar__item';
  loading.setAttribute('aria-disabled', 'true');
  loading.textContent = 'načítám větve…';
  menu.appendChild(loading);

  const closeMenu = () => {
    wrap.classList.remove('is-open');
    if (document.activeElement && wrap.contains(document.activeElement)) document.activeElement.blur();
  };

  ghListBranches(spec).then((branches) => {
    if (!branches.length) {
      menu.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'srcbar__item';
      empty.setAttribute('aria-disabled', 'true');
      empty.textContent = '(žádné větve)';
      menu.appendChild(empty);
      return;
    }
    const ordered = branches.slice().sort((a, b) => {
      if (a === current) return -1;
      if (b === current) return 1;
      return a.localeCompare(b);
    });
    menu.innerHTML = '';
    for (const b of ordered) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'srcbar__item' + (b === current ? ' srcbar__item--current' : '');
      item.textContent = b;
      if (b === current) {
        item.disabled = true;
      } else {
        item.addEventListener('click', async () => {
          closeMenu();
          try {
            await connectGithub({ ...spec, branch: b });
          } catch (err) {
            console.error('branch switch failed', err);
          }
        });
      }
      menu.appendChild(item);
    }
  }).catch((err) => {
    console.error('branches', err);
    menu.innerHTML = '';
    const errEl = document.createElement('div');
    errEl.className = 'srcbar__item';
    errEl.setAttribute('aria-disabled', 'true');
    errEl.textContent = 'chyba při načítání větví';
    menu.appendChild(errEl);
  });
}

function showPublishDialog() {
  if (document.querySelector('[data-pub-dialog]')) return;
  if (state.githubSpec) {
    showGithubPublishDialog();
  } else if (state.rootHandle) {
    showDirSaveDialog();
  } else if (state.uploadedSnapshot) {
    showZipExportDialog();
  }
}

function buildDialogShell(ariaLabel) {
  const wrap = document.createElement('div');
  wrap.className = 'gh-dialog';
  wrap.setAttribute('data-pub-dialog', '');
  wrap.innerHTML = `
    <div class="gh-dialog__panel pub-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(ariaLabel)}">
      <button type="button" class="pub-dialog__close" data-pub-close aria-label="Zavřít">×</button>
      <div data-pub-body></div>
    </div>
  `;
  document.body.appendChild(wrap);

  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey);
  wrap.querySelector('[data-pub-close]').addEventListener('click', close);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });

  return { wrap, body: wrap.querySelector('[data-pub-body]'), close };
}

function showZipExportDialog() {
  const name = state.uploadedSnapshot?.name || 'zdroj';
  const { body, close } = buildDialogShell('Stáhnout jako ZIP');

  const info = `Nahraná složka <b>${escapeHtml(name)}</b> žije jen v paměti prohlížeče. Vaše úpravy se ukládají do <em>localStorage</em>. Pro persistenci si stáhněte aktuální verzi jako ZIP a rozbalte ji přes původní složku.`;

  body.innerHTML = `
    <h2 class="gh-dialog__title">Stáhnout jako ZIP</h2>
    <p class="gh-dialog__hint">${info}</p>
    <div class="gh-dialog__buttons">
      <button type="button" class="gh-dialog__btn" data-pub-cancel>Zavřít</button>
      <button type="button" class="gh-dialog__btn gh-dialog__btn--primary" data-pub-download>Stáhnout ZIP</button>
    </div>
  `;

  body.querySelector('[data-pub-cancel]').addEventListener('click', close);
  body.querySelector('[data-pub-download]').addEventListener('click', async () => {
    await exportAsZip();
    close();
  });
}

function showDirSaveDialog() {
  const name = state.rootHandle?.name || 'složka';
  const { body, close } = buildDialogShell(`Uložit změny do ${name}`);
  const sum = collectDirChangesSummary();
  const total = sum.adds.length + sum.removes.length + sum.mods.length;

  const renderChangeList = () => {
    if (!total) return `<div class="pub-dialog__changes-empty">Žádné lokální změny.</div>`;
    const row = (kind, path) =>
      `<div class="pub-dialog__change pub-dialog__change--${kind}"><span class="pub-dialog__change-kind">${kind}</span><span class="pub-dialog__change-path">${escapeHtml(path)}</span></div>`;
    const rows = [];
    for (const a of sum.adds) rows.push(row('add', a.path + (a.kind === 'dir' ? '/' : '')));
    for (const m of sum.mods) rows.push(row('mod', m.path));
    for (const r of sum.removes) rows.push(row('del', r.path));
    return rows.join('');
  };

  body.innerHTML = `
    <div class="pub-dialog__head">
      <span class="pub-dialog__repo">${escapeHtml(name)}</span>
      <span class="pub-dialog__branch-ctx" aria-label="Typ zdroje">
        <span class="pub-dialog__branch-glyph" aria-hidden="true">/</span>
        <span>složka na disku</span>
      </span>
    </div>
    <p class="gh-dialog__hint">Změny se zapíšou přímo do připojené složky přes File System Access API. Smazané soubory zmizí trvale.</p>
    <div class="pub-dialog__changes" data-pub-changes>${renderChangeList()}</div>
    <div class="gh-dialog__buttons">
      <button type="button" class="gh-dialog__btn" data-pub-cancel>Zavřít</button>
      <button type="button" class="gh-dialog__btn gh-dialog__btn--primary" data-pub-save ${total ? '' : 'disabled'}>Uložit změny</button>
    </div>
    <div class="pub-dialog__status" data-pub-status hidden></div>
  `;

  const cancelBtn = body.querySelector('[data-pub-cancel]');
  const saveBtn = body.querySelector('[data-pub-save]');
  const statusEl = body.querySelector('[data-pub-status]');
  const setStatus = (msg, kind = '') => {
    statusEl.hidden = false;
    statusEl.textContent = msg;
    if (kind) statusEl.setAttribute('data-kind', kind);
    else statusEl.removeAttribute('data-kind');
  };

  cancelBtn.addEventListener('click', close);
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    setStatus('ukládám…');
    try {
      const res = await saveLocalEditsToFS({ onStatus: (m) => setStatus(m) });
      const parts = [];
      if (res.written) parts.push(`${res.written} souborů`);
      if (res.removed) parts.push(`${res.removed} smazáno`);
      if (res.dirsCreated) parts.push(`${res.dirsCreated} adresářů`);
      if (res.errors.length) {
        setStatus(`Hotovo s chybami (${res.errors.length}): ${res.errors[0].path} — ${res.errors[0].err}`, 'err');
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
        renderPublishButton();
        return;
      }
      setStatus(`Uloženo: ${parts.join(', ') || 'beze změn'}.`, 'ok');
      renderPublishButton();
      setTimeout(close, 800);
    } catch (e) {
      setStatus(`Chyba: ${e.message}`, 'err');
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  });
}

function showGithubPublishDialog() {
  const spec = state.githubSpec;
  if (!spec) return;
  const branch = spec.branch || 'main';
  const { wrap, body, close } = buildDialogShell(`Publish do ${spec.owner}/${spec.repo}`);

  const tokenFieldHtml = spec.token ? '' : `
    <div class="pub-dialog__field">
      <div class="pub-dialog__field-row">
        <span>Token <em>(potřeba pro push)</em></span>
        <a class="pub-dialog__link" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">kde ho vzít?</a>
      </div>
      <input class="pub-dialog__input" type="password" data-pub-token placeholder="ghp_… / github_pat_…" autocomplete="off" spellcheck="false">
      <div class="pub-dialog__warn">Uloží se nezašifrovaně do prohlížeče (IndexedDB). Na sdíleném počítači použijte token jen jednorázově (smažte přes „Odpojit").</div>
    </div>
  `;

  body.innerHTML = `
    <div class="pub-dialog__head">
      <span class="pub-dialog__repo">${escapeHtml(spec.owner)}/${escapeHtml(spec.repo)}</span>
      <span class="pub-dialog__branch-ctx" aria-label="Větev">
        <span class="pub-dialog__branch-glyph" aria-hidden="true">⎇</span>
        <span>${escapeHtml(branch)}</span>
      </span>
    </div>
    <div class="pub-dialog__changes" data-pub-changes>
      <div class="pub-dialog__changes-empty">načítám změny…</div>
    </div>
    <input class="pub-dialog__input" type="text" data-pub-msg placeholder="popis změny" autocomplete="off" spellcheck="false" value="update z fakan.cz">
    ${tokenFieldHtml}
    <div class="pub-dialog__status" data-pub-status></div>
    <div class="gh-dialog__buttons">
      <button type="button" class="gh-dialog__btn" data-pub-cancel>Zrušit</button>
      <button type="button" class="gh-dialog__btn gh-dialog__btn--primary" data-pub-publish disabled>Publish</button>
    </div>
  `;

  const changesEl = body.querySelector('[data-pub-changes]');
  const msgIn = body.querySelector('[data-pub-msg]');
  const tokenIn = body.querySelector('[data-pub-token]');
  const statusEl = body.querySelector('[data-pub-status]');
  const publishBtn = body.querySelector('[data-pub-publish]');
  const cancelBtn = body.querySelector('[data-pub-cancel]');

  cancelBtn.addEventListener('click', close);

  // Diff vůči GitHub HEAD
  const renderChanges = (files) => {
    if (!files.length) {
      changesEl.innerHTML = '<div class="pub-dialog__changes-empty">žádné změny</div>';
      publishBtn.disabled = true;
      return;
    }
    const prefix = { mod: 'M', add: '+', del: '−' };
    const items = files.map((f) =>
      `<li class="pub-dialog__change pub-dialog__change--${f.kind}">` +
      `<span class="pub-dialog__change-kind">${prefix[f.kind]}</span>` +
      `<span class="pub-dialog__change-path">${escapeHtml(f.path)}</span>` +
      `</li>`
    ).join('');
    const noun = files.length === 1 ? 'změna' : files.length < 5 ? 'změny' : 'změn';
    const truncNote = state.ghBaselineTruncated
      ? '<div class="pub-dialog__warn">strom byl při načtení zkrácen — některé soubory baseline nezná</div>'
      : '';
    changesEl.innerHTML = `
      <div class="pub-dialog__changes-count">${files.length} ${noun} k odeslání</div>
      ${truncNote}
      <ul>${items}</ul>
    `;
    publishBtn.disabled = false;
  };

  collectGithubPushFiles(state.originalTree).then(renderChanges).catch((err) => {
    console.error('diff failed', err);
    changesEl.innerHTML = '<div class="pub-dialog__changes-empty">chyba při čtení stromu</div>';
    publishBtn.disabled = true;
  });

  const publish = async () => {
    const message = msgIn.value.trim();
    if (!message) { statusEl.dataset.kind = 'err'; statusEl.textContent = 'Vyplňte popis změny.'; msgIn.focus(); return; }
    const token = (tokenIn?.value.trim()) || spec.token;
    if (!token) { statusEl.dataset.kind = 'err'; statusEl.textContent = 'Pro push potřebujete token.'; tokenIn?.focus(); return; }
    publishBtn.disabled = true;
    statusEl.dataset.kind = 'info';
    statusEl.textContent = 'sbírám soubory…';
    try {
      const files = await collectGithubPushFiles(state.originalTree);
      if (!files.length) {
        statusEl.dataset.kind = 'err';
        statusEl.textContent = 'Žádné změny k odeslání.';
        publishBtn.disabled = true;
        return;
      }
      const pushSpec = { ...spec, token, branch };
      const res = await ghPush(pushSpec, message, files, (m) => { statusEl.textContent = m; });
      if (res.unchanged) {
        statusEl.dataset.kind = 'err';
        statusEl.textContent = 'Strom je shodný s remote — nic nepushlo.';
        publishBtn.disabled = false;
        return;
      }
      statusEl.dataset.kind = 'ok';
      statusEl.textContent = `Hotovo — commit ${res.sha.slice(0, 7)}.`;
      if (tokenIn?.value.trim() && tokenIn.value.trim() !== spec.token) {
        state.githubSpec = { ...spec, token: tokenIn.value.trim() };
        await idbSetGithubSpec(state.githubSpec);
      }
      setTimeout(() => { close(); renderPublishButton(); }, 1200);
    } catch (err) {
      console.error('push failed', err);
      statusEl.dataset.kind = 'err';
      statusEl.textContent = `Chyba: ${err.message}`;
      publishBtn.disabled = false;
    }
  };
  publishBtn.addEventListener('click', publish);
  const onEnter = (e) => { if (e.key === 'Enter' && !publishBtn.disabled) { e.preventDefault(); publish(); } };
  msgIn.addEventListener('keydown', onEnter);
  tokenIn?.addEventListener('keydown', onEnter);
}

// --- zdrojové menu v navu ---------------------------------------------------

export function renderSourceMenu() {
  mountSrcbarToggle();
  renderPublishButton();
  renderBranchPicker();
  const label = document.querySelector('[data-source-label]');
  const menu = document.querySelector('[data-source-menu]');
  const labelText = state.rootHandle ? state.rootHandle.name
    : state.githubSpec ? `${state.githubSpec.owner}/${state.githubSpec.repo}`
    : state.uploadedSnapshot ? state.uploadedSnapshot.name
    : 'Zdroj';
  if (label) label.textContent = labelText;
  if (!menu) return;
  menu.innerHTML = '';

  const hasSource = !!(state.rootHandle || state.githubSpec || state.uploadedSnapshot);
  const canFsAccess = typeof window.showDirectoryPicker === 'function';
  const items = [];
  items.push({
    label: 'Nahrát složku (lokálně)',
    onClick: openUploadPicker,
    title: 'Nahraje složku do paměti prohlížeče. Edity se ukládají jen lokálně, pro persistenci stáhněte ZIP.',
  });
  items.push({
    label: 'Připojit složku (na disku)',
    onClick: canFsAccess ? openDirectoryPicker : null,
    disabled: !canFsAccess,
    title: canFsAccess
      ? 'Připojí reálnou složku přes File System Access API. Edity se zapisují přímo na disk.'
      : 'Tento prohlížeč nepodporuje File System Access API (zkuste Chrome / Edge / Brave).',
  });
  items.push({
    label: 'Připojit GitHub',
    onClick: showGithubDialog,
  });
  if (state.githubSpec) {
    const { owner, repo } = state.githubSpec;
    items.push({
      label: 'Pozvat ke spolupráci…',
      onClick: () => window.open(`https://github.com/${owner}/${repo}/settings/access`, '_blank', 'noopener'),
      title: `Otevře nastavení přístupu pro ${owner}/${repo} na GitHubu, kde můžete přidat spolupracovníka.`,
    });
  }
  if (!state.githubSpec && hasSource) {
    items.push({ label: 'Stáhnout jako ZIP', onClick: exportAsZip });
  } else if (!hasSource) {
    items.push({ label: 'Stáhnout jako ZIP', disabled: true, title: 'Nejprve připojte zdroj' });
  }
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
    b.className = 'srcbar__item' + (it.danger ? ' srcbar__item--danger' : '');
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
    sep.className = 'srcbar__sep';
    sep.textContent = 'Nedávné';
    menu.appendChild(sep);

    for (const entry of past) {
      const row = document.createElement('div');
      row.className = 'srcbar__item srcbar__item--recent';
      if (entry.type === 'zip') row.classList.add('srcbar__item--dim');

      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'srcbar__item-main';
      const icon = entry.type === 'dir' ? '/' : entry.type === 'git' ? '⎇' : '⤓';
      main.innerHTML = `<span class="srcbar__item-icon" aria-hidden="true">${icon}</span><span class="srcbar__item-label">${escapeHtml(entry.label)}</span>`;
      if (entry.type === 'zip') {
        main.title = 'Nahraná složka — pro otevření ji nahrajte znovu';
      }
      main.addEventListener('click', () => {
        closeMenu();
        reconnectRecent(entry);
      });
      row.appendChild(main);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'srcbar__item-del';
      del.setAttribute('aria-label', 'Odstranit z historie');
      del.title = 'Odstranit z historie';
      del.textContent = '×';
      const entryKey = recentKey(entry);
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        const cur = await idbGetRecent();
        await idbSetRecent(cur.filter((it) => recentKey(it) !== entryKey));
        renderSourceMenu();
      });
      row.appendChild(del);

      menu.appendChild(row);
    }
  }).catch(() => {});
}

// --- floating badge --------------------------------------------------------

export function mountBadge() {
  const wrap = document.getElementById('badge');
  if (!wrap) return;
  wrap.innerHTML = `
    <div class="badge__meta-row">
      <button class="badge__more" type="button" data-badge-more aria-label="Více odkazů" aria-expanded="false">
        <span class="badge__more-glyph" aria-hidden="true">≡</span>
        <span class="badge__more-label">menu</span>
      </button>
      <div class="badge__links" data-badge-links>
        <a class="badge__meta" href="#" data-badge-help>help</a>
        <span class="badge__meta-sep" aria-hidden="true">·</span>
        <a class="badge__meta" href="#" data-badge-tip>přispět</a>
        <span class="badge__meta-sep" aria-hidden="true">·</span>
        <a class="badge__meta" href="https://github.com/junkycoder/fakan" target="_blank" rel="noopener">github</a>
        <span class="badge__meta-sep" aria-hidden="true">·</span>
        <a class="badge__meta" href="mailto:hromada.dan@gmail.com?subject=Zdrav%C3%ADm%20z%20fakan.cz">kontakt</a>
      </div>
    </div>
  `;
  wrap.removeAttribute('hidden');
  wrap.querySelector('[data-badge-tip]').addEventListener('click', (e) => {
    e.preventDefault();
    showTipDialog();
  });
  wrap.querySelector('[data-badge-help]').addEventListener('click', (e) => {
    e.preventDefault();
    showHelpDialog();
  });
  // Po kliku na jakýkoli odkaz menu zavřít (mobil)
  wrap.querySelectorAll('.badge__links a').forEach((a) => {
    a.addEventListener('click', () => closeBadge(wrap));
  });

  const more = wrap.querySelector('[data-badge-more]');
  more.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const open = wrap.classList.toggle('is-open');
    more.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.addEventListener('pointerdown', (e) => {
    if (!wrap.classList.contains('is-open')) return;
    if (wrap.contains(e.target)) return;
    closeBadge(wrap);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!wrap.classList.contains('is-open')) return;
    closeBadge(wrap);
    more.focus({ preventScroll: true });
  });

  // Hledat pill v srcbaru → otevři search dialog
  const searchBtn = document.querySelector('[data-search-btn]');
  searchBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    showSearchDialog();
  });
}

function closeBadge(wrap) {
  wrap.classList.remove('is-open');
  wrap.querySelector('[data-badge-more]')?.setAttribute('aria-expanded', 'false');
}

// --- Help dialog -----------------------------------------------------------

function showHelpDialog() {
  document.querySelector('[data-help-dialog]')?.remove();

  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
  const mod = isMac ? '⌘' : 'Ctrl';

  const wrap = document.createElement('div');
  wrap.className = 'help-dialog';
  wrap.setAttribute('data-help-dialog', '');
  wrap.innerHTML = `
    <div class="help-dialog__panel" role="dialog" aria-modal="true" aria-labelledby="help-title">
      <button type="button" class="help-dialog__close" data-help-close aria-label="Zavřít">×</button>
      <div class="help-dialog__scroll">
        <h2 class="help-dialog__title" id="help-title">Jak na fakana</h2>

        <p class="help-dialog__lede">
          Mindmapa pro procházení vašich poznámek, projektů a kódu jako stromu na monospace
          gridu. Místo file manageru nebo blogu — jedna obrazovka, všechno na očích, vše dosažitelné
          ze šipek.
        </p>

        <h3>K čemu se to hodí</h3>
        <ul>
          <li><b>Druhý mozek na webu.</b> Markdown poznámky, deník, kontakty, projekty — vše z jednoho repa, sdíleno linkem.</li>
          <li><b>Portfolio bez CMS.</b> Strom souborů v GitHub repu = veřejný web. Žádný build, žádný editor.</li>
          <li><b>Procházení cizích repů.</b> Vložte <code>github:owner/repo</code> a koukněte se na strom v mapě místo v ascii <code>tree</code>.</li>
          <li><b>Lokální browsing.</b> Připojte složku přes File System handle a používejte fakana jako čtečku/navigátor přes vlastní disk.</li>
          <li><b>Bez sledování.</b> Žádná data o vás neshromažďujeme ani neměříme. Žádné analytics, žádné cookies, žádné logy o chování — co děláte v mapě, zůstává u vás.</li>
        </ul>

        <h3>Základní ovládání</h3>
        <table class="help-dialog__keys">
          <tr><td><kbd>←</kbd> <kbd>↓</kbd> <kbd>↑</kbd> <kbd>→</kbd> &nbsp; (nebo <kbd>h</kbd> <kbd>j</kbd> <kbd>k</kbd> <kbd>l</kbd>)</td><td>pohyb po stromě podle kvadrantu</td></tr>
          <tr><td><kbd>Enter</kbd></td><td>otevřít soubor v hlavním panelu / na složce recenter</td></tr>
          <tr><td><kbd>Shift</kbd>+<kbd>Enter</kbd></td><td>soubor: jediné okno (zavře ostatní). Složka: recenter.</td></tr>
          <tr><td><kbd>Space</kbd></td><td>follower preview vedle focusu (sleduje pohyb šipkami)</td></tr>
          <tr><td><kbd>Space</kbd> 2×</td><td>zavře follower preview</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>zavřít nejvyšší panel</td></tr>
          <tr><td><kbd>0</kbd></td><td>vrátit mapu na střed (pohled na celý strom)</td></tr>
        </table>

        <h3>Hierarchická navigace (jako browser back/forward)</h3>
        <table class="help-dialog__keys">
          <tr><td><kbd>${mod}</kbd>+<kbd>←</kbd></td><td>o úroveň výš (parent složka); na rootu recenter na rodičovský strom</td></tr>
          <tr><td><kbd>${mod}</kbd>+<kbd>→</kbd></td><td>o úroveň níž (první potomek); vrací forward stack po Cmd+←</td></tr>
          <tr><td>klik na <code>~/</code></td><td>zpátky na hlavní strom</td></tr>
        </table>

        <h3>Panely a taby</h3>
        <p class="help-dialog__note">Na Macu používejte <kbd>Ctrl</kbd>, ne <kbd>⌘</kbd> — <kbd>⌘</kbd>+<kbd>Shift</kbd>+W/[/]/1–9 kolidují se zkratkami prohlížeče.</p>
        <table class="help-dialog__keys">
          <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd></td><td>zavřít aktivní panel</td></tr>
          <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>[</kbd> / <kbd>]</kbd></td><td>cyklit mezi taby</td></tr>
          <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>1</kbd>…<kbd>9</kbd></td><td>skok na n-tý panel</td></tr>
          <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd></td><td>maximalizovat aktivní panel</td></tr>
          <tr><td><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd></td><td>otevřít aktuální focus jako follower preview</td></tr>
        </table>

        <h3>Terminál</h3>
        <p>
          Plnohodnotný shell přímo v prohlížeči — pohyb po zdroji, čtení i zápis souborů
          (přes overlay, publish stávajícím tlačítkem), spouštění <code>.sh</code> skriptů.
          Každý terminál je vlastní panel, otevřete jich kolik chcete.
        </p>
        <table class="help-dialog__keys">
          <tr><td><kbd>${mod}</kbd>+<kbd>T</kbd></td><td>otevřít nový terminál</td></tr>
          <tr><td>ve vimu <kbd>Ctrl</kbd>+<kbd>Z</kbd></td><td>suspend editoru → skok do terminálu (jako bash)</td></tr>
          <tr><td>v terminálu <code>fg</code></td><td>návrat do suspendovaného editoru</td></tr>
          <tr><td>v terminálu <kbd>↑</kbd> / <kbd>↓</kbd></td><td>historie (sdílená napříč terminály a sessions)</td></tr>
          <tr><td>v terminálu <kbd>Tab</kbd></td><td>doplnit příkaz (první slovo) nebo cestu</td></tr>
          <tr><td>v terminálu <kbd>Ctrl</kbd>+<kbd>L</kbd></td><td>clear obrazovky</td></tr>
          <tr><td>v terminálu <kbd>Ctrl</kbd>+<kbd>C</kbd></td><td>zruš rozepsaný řádek</td></tr>
          <tr><td>v terminálu <kbd>Ctrl</kbd>+<kbd>D</kbd></td><td>EOF — na prázdném inputu zavře terminál (jako bash)</td></tr>
        </table>
        <p>Vestavěné příkazy: <code>pwd</code>, <code>cd</code>, <code>ls</code>, <code>cat</code>,
        <code>echo</code>, <code>head</code>, <code>tail</code>, <code>wc</code>,
        <code>mkdir</code>, <code>touch</code>, <code>rm</code>, <code>cp</code>, <code>mv</code>,
        <code>grep</code>, <code>find</code>, <code>history</code>, <code>alias</code>,
        <code>export</code>, <code>env</code>, <code>bash</code>, <code>source</code>,
        <code>clear</code>, <code>exit</code>, <code>help</code>.
        Plus syntaxe shellu — roury <code>|</code>, redirekce <code>&gt;</code> <code>&gt;&gt;</code> <code>&lt;</code>,
        operátory <code>&amp;&amp;</code> <code>||</code> <code>;</code>, proměnné <code>$VAR</code>,
        globy <code>*.md</code>, bloky <code>for</code>/<code>if</code>/<code>while</code>.</p>
        <p>Fakan-specifické příkazy proti vlastnímu UI: <code>open &lt;cesta&gt;</code>,
        <code>vim &lt;cesta&gt;</code>, <code>preview &lt;cesta&gt;</code>,
        <code>dock left|right|top|bottom|full</code>, <code>panels</code>, <code>recenter</code>.</p>
        <p>Soubor <code>~/.fakanrc</code> se auto-sourcne při startu každého terminálu —
        místo na aliasy, prompt, <code>export</code> proměnných.</p>

        <h3>CI runner (Cloudflare)</h3>
        <p>
          <code>ci run script.sh</code> nebo <code>ci run -c "echo ahoj"</code> pošle skript
          do Cloudflare Workeru, který ho spustí v ephemeral kontejneru (Alpine + bash +
          coreutils + curl + jq + git) a výstup streamuje zpět do terminálu. Vyžaduje
          per-token autorizaci přes <code>ci token &lt;secret&gt;</code> (token musí odpovídat
          <code>RUNNER_SECRET</code> na Workeru). Status: <code>ci health</code>,
          <code>ci version</code>, denní využití: <code>ci quota</code>.
        </p>

        <h3>Vlastní stroj přes tunel</h3>
        <p>
          Stejné rozhraní jako CI runner, ale skript běží na <b>vašem stroji</b> —
          Raspberry Pi, domácím serveru, EC2 instanci, druhém Macu — přes
          persistent WebSocket k Cloudflare Worker Durable Objectu. Žádný port
          forward, žádný SSH klíč: stroj se sám hlásí ven, tunel je obousměrný.
        </p>
        <p><b>Spárování</b> (5 min flow, jednorázově per stroj):</p>
        <ol>
          <li>V terminálu fakanu: <code>ci tunnel pair home-pi</code> → vrátí 6-místný kód.</li>
          <li>Na cílovém stroji nainstalujte <code>fakan-agent</code> (Go binary, ~8 MB; návod v
          <code>agent/README.md</code>) a spusťte <code>fakan-agent pair &lt;kód&gt; home-pi</code>.
          Token se uloží do <code>~/.fakan/agent.json</code> (chmod 600).</li>
          <li>Pak <code>fakan-agent run</code> (nebo přes systemd / launchd) drží stálé
          spojení s reconnectem.</li>
        </ol>
        <p><b>Použití</b> z terminálu fakanu:</p>
        <table class="help-dialog__keys">
          <tr><td><code>ci tunnel machines</code></td><td>seznam spárovaných strojů</td></tr>
          <tr><td><code>ci tunnel run &lt;id&gt; -c "&hellip;"</code></td><td>spustit inline příkaz na stroji</td></tr>
          <tr><td><code>ci tunnel run &lt;id&gt; deploy.sh</code></td><td>spustit lokální .sh soubor na stroji</td></tr>
          <tr><td><code>ci tunnel revoke &lt;id&gt;</code></td><td>odebrat stroj a invalidovat jeho token</td></tr>
        </table>
        <p>
          Limity: max 8 strojů per účet, output 5 MB / run, jeden job najednou per agent.
          Bezpečnost: agent token je single-secret v KV, hash-only ukládání;
          každý run běží jako <code>bash -c</code> pod uživatelem, kterým je daemon
          spuštěný — proto agent NEspouštějte jako root.
        </p>

        <h3>Zdroje dat</h3>
        <p>
          Tlačítkem v levém horním rohu („Zdroj“) přepínáte odkud fakan čte strom:
        </p>
        <ul>
          <li><b>GitHub repo</b> — <code>github:owner/repo[@branch]</code>. Veřejné fungují anonymně, na soukromé zadejte token.</li>
          <li><b>Lokální složka</b> — File System Access API (Chrome/Edge/Arc). Strom se promítá živě z disku.</li>
          <li><b>Snapshot</b> — nahraný ZIP/složka. Read-only, hodí se na demo nebo offline procházení.</li>
        </ul>
        <p>Vedle zdroje sedí přepínač větve (pro GitHub) a tlačítko <b>Publish</b> / <b>Stáhnout</b> — publishne změny rovnou do GitHubu, nebo si stáhne ZIP. Nedávné zdroje najdete v dropdownu „Zdroj“.</p>

        <h3>Mapa — jak se kreslí</h3>
        <p>
          Top-level složky se rozdělí do čtyř kvadrantů podle smyslu obsahu:
        </p>
        <ul>
          <li><b>↑ nahoru</b> — <code>diary</code>, <code>texty</code>, <code>notes</code>, <code>blog</code>, <code>.md</code> v rootu</li>
          <li><b>↓ dolů</b> — <code>projects</code>, <code>design</code>, <code>work</code>, <code>prace</code></li>
          <li><b>→ doprava</b> — <code>code</code>, <code>src</code>, <code>infra</code>, dotfiles, zdrojáky</li>
          <li><b>← doleva</b> — <code>about</code>, <code>contacts</code>, <code>kontakt</code>, <code>services</code>, <code>ja</code></li>
        </ul>

        <h3>Tipy pro flow</h3>
        <ul>
          <li><b>Rychlá orientace.</b> Stiskněte <kbd>0</kbd> kdykoli se ztratíte — uvidíte celou mapu.</li>
          <li><b>Čtení deníku.</b> Šipka nahoru, pak <kbd>Space</kbd>. Šipky teď listují den po dni a follower se sám obnovuje.</li>
          <li><b>Hluboký podstrom.</b> Šipkou se postavte na složku, <kbd>Enter</kbd> = recenter. Mapa se přepne, jako byste vstoupili dovnitř. <kbd>${mod}</kbd>+<kbd>←</kbd> zpátky.</li>
          <li><b>Side-by-side.</b> <kbd>Enter</kbd> otevře main panel, <kbd>Space</kbd> přidá preview vedle. Můžete porovnávat poznámky.</li>
          <li><b>Vlastní web během minuty.</b> Forkněte si content repo, přepněte zdroj na něj, sdílejte URL.</li>
        </ul>

        <h3>Drobnosti</h3>
        <ul>
          <li>Klik na název složky = recenter, klik na soubor = otevřít v hlavním panelu.</li>
          <li>Klávesnice nefunguje, když píšete do editoru — zaměřte mapu (klik mimo input nebo <kbd>Esc</kbd>).</li>
          <li>URL v adrese se synchronizuje se stavem — link funguje jako záložka přesně na ten uzel.</li>
        </ul>
      </div>
      <div class="help-dialog__buttons">
        <button type="button" class="help-dialog__btn" data-help-close>Zavřít</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  wrap.querySelectorAll('[data-help-close]').forEach((b) => b.addEventListener('click', close));
}

// --- Tip dialog (QR Platba) -------------------------------------------------

function showTipDialog() {
  // zavři případnou existující instanci
  document.querySelector('[data-tip-dialog]')?.remove();

  const accountDisplay = `${TIP_ACCOUNT}/${TIP_BANK}`;
  // IBAN naformátovaný do skupin po 4 znacích pro čitelnost
  const ibanPretty = TIP_IBAN.replace(/(.{4})/g, '$1 ').trim();

  const wrap = document.createElement('div');
  wrap.className = 'tip-dialog';
  wrap.setAttribute('data-tip-dialog', '');
  wrap.innerHTML = `
    <div class="tip-dialog__panel" role="dialog" aria-modal="true" aria-labelledby="tip-title">
      <h2 class="tip-dialog__title" id="tip-title">Děkujeme, že přemýšlíte přispět</h2>
      <p class="tip-dialog__intro">Načtěte QR kód v bankovní aplikaci, nebo zkopírujte číslo účtu.</p>
      <div class="tip-dialog__qr" data-tip-qr aria-hidden="true"></div>
      <div class="tip-dialog__account">
        <span class="tip-dialog__account-num" data-tip-account>${accountDisplay}</span>
        <button type="button" class="tip-dialog__btn tip-dialog__btn--copy" data-tip-copy>Zkopírovat</button>
      </div>
      <div class="tip-dialog__iban">IBAN: ${ibanPretty}</div>
      <div class="tip-dialog__buttons">
        <button type="button" class="tip-dialog__btn" data-tip-close>Zavřít</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  // Vykreslit QR (SPAYD — Short Payment Descriptor, CZ standard).
  const qrEl = wrap.querySelector('[data-tip-qr]');
  try {
    // typeNumber=0 → auto-fit; error correction 'M' → ~15 % redundance
    const qr = window.qrcode(0, 'M');
    qr.addData(`SPD*1.0*ACC:${TIP_IBAN}*CC:CZK*MSG:fakan.cz tip`);
    qr.make();
    // cellSize=5, margin=2 → cca 165×165 px pro typickou velikost
    qrEl.innerHTML = qr.createSvgTag(5, 2);
  } catch (err) {
    console.error('QR render failed', err);
    qrEl.textContent = '(QR se nepodařilo vykreslit)';
  }

  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('[data-tip-close]').addEventListener('click', close);

  const copyBtn = wrap.querySelector('[data-tip-copy]');
  const accountSpan = wrap.querySelector('[data-tip-account]');
  copyBtn.addEventListener('click', async () => {
    const orig = copyBtn.textContent;
    let ok = false;
    try {
      await navigator.clipboard.writeText(accountDisplay);
      ok = true;
    } catch {
      // fallback: vyber text v <span> aby ho šlo Cmd/Ctrl+C
      const range = document.createRange();
      range.selectNodeContents(accountSpan);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    copyBtn.textContent = ok ? 'Zkopírováno' : 'Vyberte a Cmd+C';
    copyBtn.disabled = true;
    setTimeout(() => {
      copyBtn.textContent = orig;
      copyBtn.disabled = false;
    }, 1800);
  });
}
