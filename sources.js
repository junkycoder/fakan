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
  applyTreeOps, clearGhBaseline,
} from './state.js';
import { rebuildMindmap } from './mindmap.js';
import { closePanel, openMain, maybeOpenDefaultIndex } from './panels.js';

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
  if (state.rootHandle) return `handle:${state.rootHandle.name}`;
  if (state.githubSpec) return `github:${state.githubSpec.owner}/${state.githubSpec.repo}@${state.githubSpec.branch || ''}`;
  if (state.uploadedSnapshot) return `snapshot:${state.uploadedSnapshot.name}`;
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

export function renderEmptyHint(emptyState) {
  const inner = document.querySelector('[data-empty-hint]');
  if (!inner) return;
  inner.innerHTML = '';
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
    await pushRecentSource('handle', handle.name || '~', handle);
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
    await pushRecentSource('snapshot', tree.name || 'snapshot', null);
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
      await pushRecentSource('github', `${spec.owner}/${spec.repo}${spec.branch ? `@${spec.branch}` : ''}`, spec);
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
    return false;
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
    return false;
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
    const ghs = list.filter((e) => e.type === 'github' && e.data?.owner && e.data?.repo);
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

// --- Branch picker ----------------------------------------------------------

function showBranchPicker() {
  if (!state.githubSpec) return;
  document.querySelector('[data-gh-branch-picker]')?.remove();

  const spec = state.githubSpec;
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
    if (!state.githubSpec || branch === state.githubSpec.branch) { close(); return; }
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

function renderGitMenu() {
  const wrap = document.querySelector('[data-nav-git]');
  if (!wrap) return;
  if (!state.githubSpec) {
    wrap.setAttribute('hidden', '');
    return;
  }
  wrap.removeAttribute('hidden');

  const spec = state.githubSpec;
  const branch = spec.branch || 'main';
  const label = wrap.querySelector('[data-git-label]');
  if (label) label.textContent = branch;

  const menu = wrap.querySelector('[data-git-menu]');
  if (!menu) return;

  const tokenFieldHtml = spec.token ? '' : `
    <div>
      <div class="nav__git-token-row">
        <span>Token <em>(potřeba pro push)</em></span>
        <a class="nav__git-token-help" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">kde ho vzít?</a>
      </div>
      <input class="nav__git-token" type="password" data-git-token placeholder="ghp_… / github_pat_…" autocomplete="off" spellcheck="false">
      <div class="nav__git-token-warn">Uloží se nezašifrovaně do prohlížeče (IndexedDB). Na sdíleném počítači použijte token jen jednorázově (smažte přes „Odpojit").</div>
    </div>
  `;

  menu.innerHTML = `
    <div class="nav__git-head">
      <span class="nav__git-repo">${escapeHtml(spec.owner)}/${escapeHtml(spec.repo)}</span>
      <a class="nav__git-branch-switch" href="#" data-git-branch>změnit větev</a>
    </div>
    <div class="nav__git-changes" data-git-changes>
      <div class="nav__git-changes-empty">načítám změny…</div>
    </div>
    <input class="nav__git-input" type="text" data-git-msg placeholder="popis změny" autocomplete="off" spellcheck="false" value="update z fakan.cz">
    ${tokenFieldHtml}
    <div class="nav__git-status" data-git-status></div>
    <button type="button" class="nav__git-publish" data-git-publish disabled>Publish</button>
  `;

  const changesEl = menu.querySelector('[data-git-changes]');
  const msgIn = menu.querySelector('[data-git-msg]');
  const tokenIn = menu.querySelector('[data-git-token]');
  const statusEl = menu.querySelector('[data-git-status]');
  const publishBtn = menu.querySelector('[data-git-publish]');
  const branchSwitch = menu.querySelector('[data-git-branch]');

  branchSwitch.addEventListener('click', (e) => {
    e.preventDefault();
    closeGitMenu();
    showBranchPicker();
  });

  // Diff vůči GitHub HEAD — async (počítá blob SHA pro každý kandidátní soubor)
  const renderChanges = (files) => {
    if (!files.length) {
      changesEl.innerHTML = '<div class="nav__git-changes-empty">žádné změny</div>';
      publishBtn.disabled = true;
      return;
    }
    const prefix = { mod: 'M', add: '+', del: '−' };
    const items = files.map((f) =>
      `<li class="nav__git-change nav__git-change--${f.kind}">` +
      `<span class="nav__git-change-kind">${prefix[f.kind]}</span>` +
      `<span class="nav__git-change-path">${escapeHtml(f.path)}</span>` +
      `</li>`
    ).join('');
    const noun = files.length === 1 ? 'změna' : files.length < 5 ? 'změny' : 'změn';
    const truncNote = state.ghBaselineTruncated
      ? '<div class="nav__git-changes-warn">strom byl při načtení zkrácen — některé soubory baseline nezná</div>'
      : '';
    changesEl.innerHTML = `
      <div class="nav__git-changes-count">${files.length} ${noun} k odeslání</div>
      ${truncNote}
      <ul>${items}</ul>
    `;
    publishBtn.disabled = false;
  };

  collectGithubPushFiles(state.originalTree).then(renderChanges).catch((err) => {
    console.error('diff failed', err);
    changesEl.innerHTML = '<div class="nav__git-changes-empty">chyba při čtení stromu</div>';
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
      setTimeout(() => { closeGitMenu(); renderGitMenu(); }, 1200);
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

function closeGitMenu() {
  const wrap = document.querySelector('[data-nav-git]');
  wrap?.classList.remove('is-open');
  if (document.activeElement && wrap?.contains(document.activeElement)) document.activeElement.blur();
}

// --- zdrojové menu v navu ---------------------------------------------------

export function renderSourceMenu() {
  renderGitMenu();
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
  const items = [];
  items.push({
    label: hasSource ? 'Otevřít jinou složku…' : 'Otevřít složku…',
    onClick: openDirectoryPicker,
  });
  items.push({
    label: state.githubSpec ? 'Připojit jiný GitHub repo…' : 'Připojit GitHub repo…',
    onClick: showGithubDialog,
  });
  if (!state.githubSpec && hasSource) {
    items.push({ label: 'Stáhnout jako ZIP', onClick: exportAsZip });
  } else if (!hasSource) {
    items.push({ label: 'Export…', disabled: true, title: 'Nejprve připojte zdroj' });
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
      const row = document.createElement('div');
      row.className = 'nav__source-item nav__source-item--recent';
      if (entry.type === 'snapshot') row.classList.add('nav__source-item--dim');

      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'nav__source-item-main';
      const icon = entry.type === 'handle' ? '/' : entry.type === 'github' ? '⎇' : '⤓';
      main.innerHTML = `<span class="nav__source-item-icon" aria-hidden="true">${icon}</span><span class="nav__source-item-label">${escapeHtml(entry.label)}</span>`;
      if (entry.type === 'snapshot') {
        main.title = 'Snapshot — pro otevření nahrajte složku znovu';
      }
      main.addEventListener('click', () => {
        closeMenu();
        reconnectRecent(entry);
      });
      row.appendChild(main);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'nav__source-item-del';
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
      <a class="badge__meta" href="#" data-badge-help>help</a>
      <span class="badge__meta-sep" aria-hidden="true">·</span>
      <a class="badge__meta" href="#" data-badge-tip>přispět</a>
      <span class="badge__meta-sep" aria-hidden="true">·</span>
      <a class="badge__meta" href="https://github.com/junkycoder/fakan" target="_blank" rel="noopener">github</a>
      <span class="badge__meta-sep" aria-hidden="true">·</span>
      <a class="badge__meta" href="mailto:hromada.dan@gmail.com?subject=Zdrav%C3%ADm%20z%20fakan.cz">kontakt</a>
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
        <table class="help-dialog__keys">
          <tr><td><kbd>${mod}</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd></td><td>zavřít aktivní panel</td></tr>
          <tr><td><kbd>${mod}</kbd>+<kbd>Shift</kbd>+<kbd>[</kbd> / <kbd>]</kbd></td><td>cyklit mezi taby</td></tr>
          <tr><td><kbd>${mod}</kbd>+<kbd>Shift</kbd>+<kbd>1</kbd>…<kbd>9</kbd></td><td>skok na n-tý panel</td></tr>
          <tr><td><kbd>${mod}</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd></td><td>maximalizovat aktivní panel</td></tr>
          <tr><td><kbd>${mod}</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd></td><td>otevřít aktuální focus jako follower preview</td></tr>
        </table>

        <h3>Zdroje dat</h3>
        <p>
          V dolní liště („Zdroj“) přepínáte odkud fakan čte strom:
        </p>
        <ul>
          <li><b>GitHub repo</b> — <code>github:owner/repo[@branch]</code>. Veřejné fungují anonymně, na soukromé zadejte token.</li>
          <li><b>Lokální složka</b> — File System Access API (Chrome/Edge/Arc). Strom se promítá živě z disku.</li>
          <li><b>Snapshot</b> — nahraný ZIP/složka. Read-only, hodí se na demo nebo offline procházení.</li>
        </ul>
        <p>Nedávno použité zdroje najdete v menu „Zdroj“. <b>Git Publish</b> commitne změny do GitHub repa rovnou z UI.</p>

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
