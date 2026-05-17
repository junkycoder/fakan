// Zdroje dat: FS Access API, upload fallback, GitHub, IndexedDB persist,
// gitignore parser, source menu, GitHub dialog, branch picker,
// empty state + drop zone + badge + waitlist wizard.

import {
  state,
  FALLBACK_PATTERNS, IDB_NAME, IDB_STORE, IDB_KEY,
  IDB_KEY_SNAPSHOT, IDB_KEY_GH, IDB_KEY_RECENT, RECENT_CAP,
  TIP_ACCOUNT, TIP_BANK, TIP_IBAN, WAITLIST_ENDPOINT, HOSTED_PRICE_CZK,
  RESERVED_SUBDOMAINS, EMAIL_RE, SUBDOMAIN_RE,
  splitExt, isTextFile, parseFrontmatter, escapeHtml, mediaKind,
} from './state.js';
import { rebuildMindmap } from './mindmap.js';
import { closePanel, openMain } from './panels.js';

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

async function loadAndMount(handle, opts = {}) {
  try {
    const tree = await loadFromHandle(handle);
    state.rootHandle = handle;
    state.githubSpec = null;
    state.uploadedSnapshot = null;
    state.originalTree = tree;
    state.currentRootPath = '';
    state.recenterHistory = [];
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
    state.rootHandle = null;
    state.githubSpec = null;
    state.uploadedSnapshot = { name: tree.name };
    state.originalTree = tree;
    state.currentRootPath = '';
    state.recenterHistory = [];
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
  state.rootHandle = null;
  state.githubSpec = spec;
  state.uploadedSnapshot = null;
  state.originalTree = tree;
  state.currentRootPath = '';
  state.recenterHistory = [];
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
  state.rootHandle = null;
  state.githubSpec = null;
  state.uploadedSnapshot = null;
  state.originalTree = null;
  state.currentRootPath = '';
  state.recenterHistory = [];
  state.treeNodes = [];
  state.currentBbox = null;
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

// Default fallback — pokud uživatel nemá žádný zdroj v IDB, načti statický
// tree.json z apex domény. Obsah jednotlivých souborů se lazy fetchne přes path.
export async function tryLoadStaticTree() {
  try {
    const res = await fetch('tree.json', { cache: 'no-cache' });
    if (!res.ok) return false;
    const tree = await res.json();
    state.rootHandle = null;
    state.githubSpec = null;
    state.uploadedSnapshot = null;
    state.originalTree = tree;
    state.currentRootPath = '';
    state.recenterHistory = [];
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
      <div class="gh-dialog__field gh-dialog__field--combo">
        <span>Repo</span>
        <div class="gh-combo" data-gh-combo>
          <input type="text" data-gh-repo placeholder="owner/repo, URL nebo vyberte ze seznamu" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
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
      <p class="gh-dialog__hint">Token zůstane jen lokálně v IndexedDB tohohle prohlížeče. S tokenem se v nabídce objeví i vaše repa.</p>
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
    } catch (err) {
      myReposError = err.message;
      myRepos = [];
    } finally {
      myReposLoading = false;
      renderList();
    }
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
      myRepos = null; myReposError = null; activeToken = null;
      if (document.activeElement === repoIn) renderList();
    }
  });

  const submit = async () => {
    const parsed = parseRepoInput(repoIn.value);
    if (!parsed) {
      statusEl.textContent = 'Zadejte owner/repo nebo URL, nebo vyberte ze seznamu.';
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

// --- zdrojové menu v navu ---------------------------------------------------

export function renderSourceMenu() {
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
  if (state.githubSpec) {
    items.push({
      label: `Větev: ${state.githubSpec.branch || '…'} ▾`,
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

export function mountBadge() {
  const wrap = document.getElementById('badge');
  if (!wrap) return;
  wrap.innerHTML = `
    <div class="badge__row">
      <button type="button" class="badge__cta badge__cta--want" data-badge-want>Já to chci taky</button>
      <button type="button" class="badge__cta badge__cta--tip" data-badge-tip>Přispět</button>
    </div>
    <div class="badge__meta-row">
      <a class="badge__meta" href="https://github.com/junkycoder/fakan" target="_blank" rel="noopener">github</a>
      <span class="badge__meta-sep" aria-hidden="true">·</span>
      <a class="badge__meta" href="mailto:hromada.dan@gmail.com">mail</a>
    </div>
  `;
  wrap.removeAttribute('hidden');
  wrap.querySelector('[data-badge-want]').addEventListener('click', () => showWizard());
  wrap.querySelector('[data-badge-tip]').addEventListener('click', () => showTipDialog());
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

function showWizard() {
  document.querySelector('[data-wizard]')?.remove();

  const wizardState = {
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
    steps.forEach((s) => s.classList.toggle('wizard__step--active', Number(s.dataset.step) === wizardState.step));
    progress.textContent = `${wizardState.step} / ${TOTAL_STEPS}`;
    prevBtn.hidden = wizardState.step === 1;
    nextBtn.textContent = wizardState.step === TOTAL_STEPS ? 'Zařadit na waitlist' : 'Pokračovat';
    setError('');
    panel.scrollTop = 0;
    // focus pro krok
    setTimeout(() => {
      if (wizardState.step === 2) emailIn.focus();
      else if (wizardState.step === 3) subIn.focus();
      else if (wizardState.step === 5) renderSummary();
    }, 0);
  };

  const renderSummary = () => {
    wrap.querySelector('[data-summary-email]').textContent = wizardState.email || '—';
    const addr = wizardState.wantsCustomDomain ? 'vlastní doména (vybereme společně)' : (wizardState.subdomain ? `${wizardState.subdomain}.fakan.cz` : '—');
    wrap.querySelector('[data-summary-addr]').textContent = addr;
    const sourceLabel = {
      github: 'GitHub repo',
      folder: 'lokální složka',
      upload: 'upload archivu',
    }[wizardState.sourceType] || '—';
    wrap.querySelector('[data-summary-source]').textContent = sourceLabel;
  };

  const validateStep = () => {
    if (wizardState.step === 2) {
      const v = emailIn.value.trim();
      if (!EMAIL_RE.test(v)) { setError('Zkontrolujte, prosím, e-mail.'); emailIn.focus(); return false; }
      wizardState.email = v;
      wizardState.consent = !!consentIn.checked;
      return true;
    }
    if (wizardState.step === 3) {
      wizardState.wantsCustomDomain = !!customIn.checked;
      if (wizardState.wantsCustomDomain) {
        wizardState.subdomain = '';
        return true;
      }
      const v = subIn.value.trim().toLowerCase();
      if (!SUBDOMAIN_RE.test(v)) { setError('Subdoména: 2 až 31 znaků, malá písmena, číslice, pomlčky. Nesmí začínat pomlčkou.'); subIn.focus(); return false; }
      if (RESERVED_SUBDOMAINS.has(v)) { setError('Tahle subdoména je rezervovaná. Zkuste jinou.'); subIn.focus(); return false; }
      wizardState.subdomain = v;
      return true;
    }
    if (wizardState.step === 4) {
      const checked = radios.querySelector('input[name="source"]:checked');
      if (!checked) { setError('Vyberte, odkud bereme obsah.'); return false; }
      wizardState.sourceType = checked.value;
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
      email: wizardState.email,
      consent: wizardState.consent,
      subdomain: wizardState.subdomain || null,
      wantsCustomDomain: wizardState.wantsCustomDomain,
      sourceType: wizardState.sourceType,
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
        <p>Ozveme se vám na <strong>${escapeHtml(wizardState.email)}</strong>, jakmile Hosted otevřeme. Žádný spam mezitím.</p>
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
    if (wizardState.step > 1) { wizardState.step -= 1; render(); }
  });
  nextBtn.addEventListener('click', () => {
    if (!validateStep()) return;
    if (wizardState.step === TOTAL_STEPS) { submit(); return; }
    wizardState.step += 1;
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
    const node = state.byPath?.get('about/zaruka.md');
    if (node) openMain(node);
  });

  render();
}
