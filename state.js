// Sdílený stav + konstanty + čisté util funkce.
// Modul neimportuje nic dalšího — všechny ostatní moduly importují odsud.

// --- konstanty --------------------------------------------------------------

export const LS_EDIT_PREFIX = 'fakan:edit:';
export const LS_TREE_OPS = 'fakan:tree-ops';
export const CHAR_W = 8.4;
export const LINE_H = 18;
export const ROOT_SCALE = 1.4;
export const PANEL_CASCADE = 28;

// Mapování top-level adresářů do kvadrantů.
// SEVER = psaní/myšlení, JIH = práce/výstupy, VÝCHOD = technika, ZÁPAD = identita/kontakt.
export const DIR_QUADRANT = {
  // sever
  diary: 'north', texty: 'north', notes: 'north', blog: 'north', zapisky: 'north',
  // jih
  projects: 'south', design: 'south', work: 'south', prace: 'south',
  // východ
  code: 'east', infra: 'east', tech: 'east', src: 'east',
  // západ
  about: 'west', contacts: 'west', kontakt: 'west', kontakty: 'west', ja: 'west', services: 'west',
};

export const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.ogv', '.ogg', '.avi', '.mkv', '.m4v']);
export const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.flac', '.aac', '.opus', '.oga']);
export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.bmp', '.ico']);
export const PDF_EXTS = new Set(['.pdf']);

export const TEXT_EXTENSIONS = new Set([
  // text & dokumenty
  '.md', '.markdown', '.txt', '.rst', '.adoc', '.tex', '.org',
  // web
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte',
  // data & config
  '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.xml',
  '.csv', '.tsv', '.ini', '.conf', '.env', '.lock',
  // skripty & shell
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  // programovací jazyky
  '.py', '.rb', '.erb', '.rake', '.gemspec', '.ru',
  '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.clj',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.m', '.mm',
  '.swift', '.php', '.pl', '.lua', '.r', '.jl', '.ex', '.exs',
  '.dart', '.zig', '.nim', '.cr', '.hs', '.ml', '.fs',
  // SQL
  '.sql', '.psql',
  // pseudo-binární ale text-friendly
  '.svg', '.log', '.diff', '.patch',
]);

export const TEXT_FILENAMES = new Set([
  'Gemfile', 'Rakefile', 'Capfile', 'Guardfile', 'Procfile',
  'Dockerfile', 'Makefile', 'Containerfile',
  'README', 'LICENSE', 'CHANGELOG', 'AUTHORS', 'CONTRIBUTORS',
  'TODO', 'NOTICE', 'COPYING', 'INSTALL', 'VERSION',
]);

export const FALLBACK_PATTERNS = [
  { pat: '.*', neg: false },
  { pat: '__pycache__', neg: false },
  { pat: 'node_modules', neg: false },
  { pat: 'vendor', neg: false },
  { pat: 'tmp', neg: false },
  { pat: 'log', neg: false },
  { pat: 'coverage', neg: false },
  { pat: 'dist', neg: false },
  { pat: 'build', neg: false },
  { pat: 'target', neg: false },
];

export const IDB_NAME = 'fakan';
export const IDB_STORE = 'handles';
export const IDB_KEY = 'rootHandle';
export const IDB_KEY_SNAPSHOT = 'uploadedSnapshot';
export const IDB_KEY_GH = 'githubSpec';
export const IDB_KEY_RECENT = 'recentSources';
export const RECENT_CAP = 8;

// Bankovní spojení pro „Přispět" dialog. IBAN spočítaný offline (mod-97).
export const TIP_ACCOUNT = '1060795014';
export const TIP_BANK = '3030';
export const TIP_IBAN = 'CZ1530300000001060795014';

// --- mutable shared state ---------------------------------------------------

export const state = {
  // tree & viewport
  originalTree: null,
  currentRootPath: '',
  currentBbox: null,
  viewportApi: null,
  byPath: new Map(),
  childrenByPath: new Map(),
  topQuadrant: new Map(),
  treeNodes: [],

  // panely
  mainPanel: null,
  previewPanels: new Map(),
  activePanel: null,
  followerPanel: null,
  lastFollowerStyles: null,
  lastPanelPos: null,
  panelZ: 100,
  panelNavListener: null,
  routeNavListener: null,
  recenterHistory: [],
  recenterForward: [],

  // klávesnice
  focusedPath: '',

  // „+ N dalších" reveal — per parent dir path, kolik souborů přibylo nad TRUNCATE_KEEP.
  // Klik na more node bump-ne hodnotu o batch a rebuilduje mindmapu in-place
  // (žádný recenter, žádná změna URL).
  expandedMore: new Map(),

  // zdroje
  rootHandle: null,
  githubSpec: null,
  uploadedSnapshot: null,

  // lokální tree edits (přidané / smazané uzly přes UI)
  treeOps: [],

  // GitHub baseline pro diff v Publish dialogu — naplněno v loadFromGithub
  ghBaselineKey: '',                  // 'owner/repo@branch'
  ghBaselineSha: new Map(),           // path -> git blob SHA z /git/trees
  ghBaselinePaths: new Set(),         // všechny cesty, které loader namountoval
  ghBaselineTruncated: false,         // true pokud GitHub tree byl truncated
  ghHasChanges: null,                 // null = ještě nezkontrolováno, bool = výsledek diffu

  // bash-style job control mezi vimem a terminálem: Ctrl+Z ve vimu pushne
  // editorový panel sem (skryje ho), `fg` v terminálu vrátí poslední
  jobStack: [],
};

// --- git blob SHA -----------------------------------------------------------
// Identický algoritmus jako `git hash-object`: sha1("blob " + byteLength + "\0" + content).
// Vrací hex string, který odpovídá `sha` v `/git/trees?recursive=1` u GitHub API.

export async function gitBlobSha(text) {
  const enc = new TextEncoder();
  const content = enc.encode(text ?? '');
  const header = enc.encode(`blob ${content.length}\0`);
  const buf = new Uint8Array(header.length + content.length);
  buf.set(header, 0);
  buf.set(content, header.length);
  const digest = await crypto.subtle.digest('SHA-1', buf);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

export function setGhBaseline({ key, sha, paths, truncated }) {
  state.ghBaselineKey = key || '';
  state.ghBaselineSha = sha instanceof Map ? sha : new Map(Object.entries(sha || {}));
  state.ghBaselinePaths = paths instanceof Set ? paths : new Set(paths || []);
  state.ghBaselineTruncated = !!truncated;
  state.ghHasChanges = null;
}

export function clearGhBaseline() {
  state.ghBaselineKey = '';
  state.ghBaselineSha = new Map();
  state.ghBaselinePaths = new Set();
  state.ghBaselineTruncated = false;
  state.ghHasChanges = null;
}

// --- čisté util funkce ------------------------------------------------------

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function cssEscapePath(p) {
  if (window.CSS && CSS.escape) return CSS.escape(p);
  return p.replace(/["\\]/g, '\\$&');
}

export function splitExt(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return [name, ''];
  return [name.slice(0, i), name.slice(i).toLowerCase()];
}

export function fileExt(node) {
  const n = (node?.filename || node?.name || '').toLowerCase();
  const i = n.lastIndexOf('.');
  return i >= 0 ? n.slice(i) : '';
}

export function mediaKind(node) {
  if (!node || node.type !== 'file') return null;
  const ext = fileExt(node);
  if (VIDEO_EXTS.has(ext) && ext !== '.ogg') return 'video';
  if (AUDIO_EXTS.has(ext) || ext === '.ogg') return 'audio';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (PDF_EXTS.has(ext)) return 'pdf';
  return null;
}

export function humanSize(bytes) {
  if (bytes == null || !isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function isTextFile(name, ext) {
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (TEXT_FILENAMES.has(name)) return true;
  // dotfiles (.gitignore, .env.local, .editorconfig) — bez mezery, žádný binární typ
  if (name.startsWith('.') && !name.includes(' ')) return true;
  return false;
}

export function parseFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!m) return [{}, text];
  const fm = {};
  for (const line of m[1].split('\n')) {
    const t = line.trim();
    if (!t || !t.includes(':')) continue;
    const idx = t.indexOf(':');
    const key = t.slice(0, idx).trim();
    let val = t.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[key] = val;
  }
  return [fm, m[2].replace(/^\n+/, '')];
}

// --- edit overlay (localStorage) --------------------------------------------

export function editKey(node) { return LS_EDIT_PREFIX + (node.path || ''); }

export function loadEditOverride(node) {
  try { return localStorage.getItem(editKey(node)); } catch { return null; }
}

export function saveEditOverride(node, text) {
  try {
    const original = node._originalRaw != null ? node._originalRaw : (node.raw != null ? node.raw : (node.content || ''));
    if (text === original) localStorage.removeItem(editKey(node));
    else localStorage.setItem(editKey(node), text);
  } catch {}
  try { window.dispatchEvent(new CustomEvent('fakan:tree-changed')); } catch {}
}

export function applyEditToNode(node, text) {
  // _originalRaw nastavujeme jen pokud už máme originál v paměti.
  // Pro lazy uzly originál dorazí později (ensureNodeContent) — nepřepisujeme
  // ho prázdným řetězcem, aby reset (`u` v editoru) fungoval správně.
  if (node._originalRaw == null && (node.raw != null || node.content != null)) {
    node._originalRaw = node.raw != null ? node.raw : (node.content || '');
  }
  node.raw = text;
  if (node.kind === 'md') node.content = text;
}

export function loadAllEditOverrides(nodes) {
  for (const n of nodes) {
    if (!n.path || n.type === 'dir' || n.type === 'root') continue;
    const saved = loadEditOverride(n);
    if (saved != null) applyEditToNode(n, saved);
  }
}

// --- tree ops (lokálně přidané / smazané uzly) ------------------------------
// Persistentní v localStorage. Aplikuje se na fresh originalTree po načtení
// zdroje. Smazané uzly nejsou zapsané do zdroje (LS-only overlay) — push do
// reálného repa je zatím TODO.

export function loadTreeOps() {
  try {
    const raw = localStorage.getItem(LS_TREE_OPS);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export function saveTreeOps(ops) {
  try {
    if (!ops || !ops.length) localStorage.removeItem(LS_TREE_OPS);
    else localStorage.setItem(LS_TREE_OPS, JSON.stringify(ops));
  } catch {}
}

export function pushTreeOp(op) {
  state.treeOps.push(op);
  saveTreeOps(state.treeOps);
}

function findDirInTree(tree, path) {
  if (!path) return tree;
  const parts = path.split('/');
  let cur = tree;
  for (const p of parts) {
    if (!cur || !Array.isArray(cur.children)) return null;
    cur = cur.children.find((c) => c.name === p && c.type === 'dir');
    if (!cur) return null;
  }
  return cur;
}

export function makeNewNode(name, isDir) {
  if (isDir) return { name, type: 'dir', children: [] };
  const [stem, ext] = splitExt(name);
  const isMd = ext === '.md';
  const isText = isTextFile(name, ext);
  const node = {
    name,
    type: 'file',
    kind: isMd ? 'md' : (isText ? 'text' : 'other'),
    filename: name,
  };
  if (isMd) { node.title = ''; node.slug = stem; node.content = ''; node.raw = ''; }
  else if (isText) { node.content = ''; node.raw = ''; }
  return node;
}

export function applyTreeOps(tree) {
  if (!tree) return tree;
  if (!state.treeOps.length) state.treeOps = loadTreeOps();
  for (const op of state.treeOps) {
    if (op.op === 'add') {
      const parent = findDirInTree(tree, op.parent || '');
      if (!parent) continue;
      if (!Array.isArray(parent.children)) parent.children = [];
      if (parent.children.some((c) => c.name === op.name)) continue;
      parent.children.push(makeNewNode(op.name, !!op.isDir));
    } else if (op.op === 'rm') {
      const parts = (op.path || '').split('/');
      const name = parts.pop();
      const parent = findDirInTree(tree, parts.join('/'));
      if (!parent || !Array.isArray(parent.children)) continue;
      parent.children = parent.children.filter((c) => c.name !== name);
    }
  }
  return tree;
}
