// Sdílený stav + konstanty + čisté util funkce.
// Modul neimportuje nic dalšího — všechny ostatní moduly importují odsud.

// --- konstanty --------------------------------------------------------------

export const LS_EDIT_PREFIX = 'fakan:edit:';
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

  // klávesnice
  focusedPath: '',

  // zdroje
  rootHandle: null,
  githubSpec: null,
  uploadedSnapshot: null,
};

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
