// vim-like editor pro panel — vanilla, bez závislostí.
// API: mountEditor(host, { text, filename, onChange, readonly }) → { destroy, focus, setText, getText }
//
// Buffer = pole řádků. Render = monospace gridy: gutter (čísla), buf (tokenizované spany),
// cursor (absolutně pozicovaný blok), selection (vrstva).
// Klávesy: motion (h/j/k/l, w/b, 0/^/$, gg/G, počty), insert (i/I/a/A/o/O),
// edit (x/X, dd/yy/p/P, cw/dw/cc), visual (v/V → y/d/c), search (/n/N), :w / :q.

const KEYWORDS = {
  js: 'await async break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new null of return super switch this throw true false try typeof undefined var void while with yield static'.split(' '),
  py: 'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield self'.split(' '),
  sh: 'if then else elif fi case esac for while do done function return in select until time'.split(' '),
  css: '!important inherit initial unset auto none'.split(' '),
  ruby: 'BEGIN END alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require require_relative attr_accessor attr_reader attr_writer'.split(' '),
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota'.split(' '),
  rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'.split(' '),
  java: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var record'.split(' '),
  c: 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false NULL nullptr class delete new this template typename namespace using public private protected virtual override final friend operator constexpr explicit mutable noexcept static_cast dynamic_cast reinterpret_cast const_cast'.split(' '),
  php: 'abstract and array as break callable case catch class clone const continue declare default die do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum eval exit extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new null or print private protected public readonly require require_once return self static switch throw trait true false try unset use var while xor yield'.split(' '),
  lua: 'and break do else elseif end false for function goto if in local nil not or repeat return then true until while self'.split(' '),
  sql: 'select from where insert into update delete create drop alter table index view as on join inner outer left right full cross union all distinct group by having order limit offset values set null not and or in is like between exists case when then else end primary key foreign references default unique check constraint with returning'.split(' '),
};

function detectLang(filename) {
  const fn = (filename || '').toLowerCase();
  if (fn.endsWith('.md') || fn.endsWith('.markdown')) return 'md';
  if (fn.endsWith('.js') || fn.endsWith('.mjs') || fn.endsWith('.cjs') || fn.endsWith('.ts') || fn.endsWith('.tsx') || fn.endsWith('.jsx')) return 'js';
  if (fn.endsWith('.css') || fn.endsWith('.scss') || fn.endsWith('.sass') || fn.endsWith('.less')) return 'css';
  if (fn.endsWith('.html') || fn.endsWith('.htm') || fn.endsWith('.svg') || fn.endsWith('.xml')) return 'html';
  if (fn.endsWith('.json') || fn.endsWith('.jsonc')) return 'json';
  if (fn.endsWith('.sh') || fn.endsWith('.bash') || fn.endsWith('.zsh') || fn.endsWith('.fish')) return 'sh';
  if (fn.endsWith('.py') || fn.endsWith('.pyw')) return 'py';
  if (fn.endsWith('.yml') || fn.endsWith('.yaml')) return 'yaml';
  if (fn.endsWith('.toml')) return 'toml';
  if (fn.endsWith('.rb') || fn.endsWith('.rake') || fn === 'gemfile' || fn === 'rakefile' || fn.endsWith('.gemspec')) return 'ruby';
  if (fn.endsWith('.go')) return 'go';
  if (fn.endsWith('.rs')) return 'rust';
  if (fn.endsWith('.java') || fn.endsWith('.kt') || fn.endsWith('.kts')) return 'java';
  if (fn.endsWith('.c') || fn.endsWith('.h') || fn.endsWith('.cpp') || fn.endsWith('.hpp') || fn.endsWith('.cc') || fn.endsWith('.cxx') || fn.endsWith('.m') || fn.endsWith('.mm')) return 'c';
  if (fn.endsWith('.php') || fn.endsWith('.phtml')) return 'php';
  if (fn.endsWith('.lua')) return 'lua';
  if (fn.endsWith('.sql')) return 'sql';
  if (fn.endsWith('.swift')) return 'c'; // approximace — keywords se liší, ale operátorová struktura sedí
  if (fn.endsWith('.dart')) return 'c';
  if (fn === 'dockerfile' || fn.endsWith('.dockerfile')) return 'sh';
  if (fn === 'makefile' || fn.endsWith('.mk')) return 'sh';
  return 'plain';
}

const escapeHtml = (s) => s
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');

// --- tokenizery -------------------------------------------------------------
// Každý vrací pole řádků; každý řádek je pole tokenů { t, cls }.
// "Multi-line state" (např. v block-comment nebo block-string) drží reduce přes řádky.

// Generický tokenizer pro C-like jazyky: js, c, java, go, rust, php, ruby, lua, sql.
// opts:
//   kws: Set<string> — keywords
//   line: array of line-comment prefixes (např. ['//', '#'])
//   block: [open, close] nebo null (např. ['/*', '*/'])
//   quotes: array of string quote chars (default ['"', "'", '`'])
//   wordRe: regex pro identifier (default /[a-zA-Z_$]/)
//   wordContRe: regex pro identifier (default /[a-zA-Z0-9_$]/)
//   caseInsensitiveKws: bool — kws matchování ignoruje case (SQL)
//   sigilVarRe: regex pro sigil proměnné (např. /\$[a-zA-Z_][\w]*/ pro PHP, /@@?[a-zA-Z_][\w]*/ pro Ruby)
function makeCLikeTokenizer(opts) {
  const kws = opts.caseInsensitiveKws
    ? new Set([...opts.kws].map((k) => k.toLowerCase()))
    : opts.kws;
  const blockOpen = opts.block ? opts.block[0] : null;
  const blockClose = opts.block ? opts.block[1] : null;
  const lineComments = opts.line || [];
  const quotes = opts.quotes || ['"', "'", '`'];
  const wordRe = opts.wordRe || /[a-zA-Z_$]/;
  const wordContRe = opts.wordContRe || /[a-zA-Z0-9_$]/;
  const sigilVarRe = opts.sigilVarRe;

  return (lines) => {
    let inBlock = false;
    return lines.map((line) => {
      const tokens = [];
      let i = 0;
      if (inBlock && blockClose) {
        const end = line.indexOf(blockClose);
        if (end === -1) { tokens.push({ t: line, cls: 'tok-cmt' }); return tokens; }
        tokens.push({ t: line.slice(0, end + blockClose.length), cls: 'tok-cmt' });
        i = end + blockClose.length;
        inBlock = false;
      }
      while (i < line.length) {
        // line comment
        let matched = false;
        for (const lc of lineComments) {
          if (line.startsWith(lc, i)) {
            tokens.push({ t: line.slice(i), cls: 'tok-cmt' });
            i = line.length;
            matched = true; break;
          }
        }
        if (matched) break;
        // block comment
        if (blockOpen && line.startsWith(blockOpen, i)) {
          const end = line.indexOf(blockClose, i + blockOpen.length);
          if (end === -1) { tokens.push({ t: line.slice(i), cls: 'tok-cmt' }); inBlock = true; break; }
          tokens.push({ t: line.slice(i, end + blockClose.length), cls: 'tok-cmt' });
          i = end + blockClose.length;
          continue;
        }
        const c = line[i];
        // string
        if (quotes.includes(c)) {
          const q = c;
          let j = i + 1;
          while (j < line.length && line[j] !== q) { if (line[j] === '\\') j++; j++; }
          tokens.push({ t: line.slice(i, Math.min(j + 1, line.length)), cls: 'tok-str' });
          i = j + 1;
          continue;
        }
        // sigil var (php $var, ruby @var/@@var)
        if (sigilVarRe) {
          sigilVarRe.lastIndex = i;
          const m = sigilVarRe.exec(line.slice(i));
          if (m && m.index === 0) {
            tokens.push({ t: m[0], cls: 'tok-var' });
            i += m[0].length;
            continue;
          }
        }
        // number
        if (/[0-9]/.test(c) && (i === 0 || !wordContRe.test(line[i - 1]))) {
          let j = i;
          while (j < line.length && /[0-9.xXa-fA-F_]/.test(line[j])) j++;
          tokens.push({ t: line.slice(i, j), cls: 'tok-num' });
          i = j;
          continue;
        }
        // identifier / keyword
        if (wordRe.test(c)) {
          let j = i;
          while (j < line.length && wordContRe.test(line[j])) j++;
          const word = line.slice(i, j);
          const matchKey = opts.caseInsensitiveKws ? word.toLowerCase() : word;
          if (kws.has(matchKey)) tokens.push({ t: word, cls: 'tok-kw' });
          else if (line[j] === '(') tokens.push({ t: word, cls: 'tok-fn' });
          else tokens.push({ t: word });
          i = j;
          continue;
        }
        if (/[{}()\[\];,.]/.test(c)) { tokens.push({ t: c, cls: 'tok-pun' }); i++; continue; }
        if (/[+\-*/%=<>!&|^~?:]/.test(c)) { tokens.push({ t: c, cls: 'tok-op' }); i++; continue; }
        tokens.push({ t: c });
        i++;
      }
      return tokens;
    });
  };
}

const tokenizeJs = makeCLikeTokenizer({
  kws: new Set(KEYWORDS.js),
  line: ['//'], block: ['/*', '*/'],
});
const tokenizeGo = makeCLikeTokenizer({
  kws: new Set(KEYWORDS.go),
  line: ['//'], block: ['/*', '*/'],
  quotes: ['"', '`'],
  wordRe: /[a-zA-Z_]/, wordContRe: /[a-zA-Z0-9_]/,
});
const tokenizeRust = makeCLikeTokenizer({
  kws: new Set(KEYWORDS.rust),
  line: ['//'], block: ['/*', '*/'],
  wordRe: /[a-zA-Z_]/, wordContRe: /[a-zA-Z0-9_]/,
});
const tokenizeJava = makeCLikeTokenizer({
  kws: new Set(KEYWORDS.java),
  line: ['//'], block: ['/*', '*/'],
  wordRe: /[a-zA-Z_$]/, wordContRe: /[a-zA-Z0-9_$]/,
});
const tokenizeC = makeCLikeTokenizer({
  kws: new Set(KEYWORDS.c),
  line: ['//'], block: ['/*', '*/'],
  wordRe: /[a-zA-Z_]/, wordContRe: /[a-zA-Z0-9_]/,
});
const tokenizePhp = makeCLikeTokenizer({
  kws: new Set(KEYWORDS.php),
  line: ['//', '#'], block: ['/*', '*/'],
  wordRe: /[a-zA-Z_]/, wordContRe: /[a-zA-Z0-9_]/,
  sigilVarRe: /^\$[a-zA-Z_][\w]*/,
});
const tokenizeRuby = makeCLikeTokenizer({
  kws: new Set(KEYWORDS.ruby),
  line: ['#'], block: ['=begin', '=end'],
  quotes: ['"', "'", '`'],
  wordRe: /[a-zA-Z_]/, wordContRe: /[a-zA-Z0-9_?!]/,
  sigilVarRe: /^@@?[a-zA-Z_][\w]*|^\$[a-zA-Z_][\w]*/,
});
const tokenizeLua = makeCLikeTokenizer({
  kws: new Set(KEYWORDS.lua),
  line: ['--'], block: ['--[[', ']]'],
  quotes: ['"', "'"],
  wordRe: /[a-zA-Z_]/, wordContRe: /[a-zA-Z0-9_]/,
});
const tokenizeSql = makeCLikeTokenizer({
  kws: new Set(KEYWORDS.sql),
  line: ['--'], block: ['/*', '*/'],
  quotes: ['"', "'"],
  caseInsensitiveKws: true,
  wordRe: /[a-zA-Z_]/, wordContRe: /[a-zA-Z0-9_]/,
});

function tokenizePy(lines) {
  const kws = new Set(KEYWORDS.py);
  let inTriple = null; // null | '"""' | "'''"
  return lines.map((line) => {
    const tokens = [];
    let i = 0;
    if (inTriple) {
      const end = line.indexOf(inTriple);
      if (end === -1) { tokens.push({ t: line, cls: 'tok-str' }); return tokens; }
      tokens.push({ t: line.slice(0, end + 3), cls: 'tok-str' });
      i = end + 3;
      inTriple = null;
    }
    while (i < line.length) {
      const c = line[i];
      if (c === '#') { tokens.push({ t: line.slice(i), cls: 'tok-cmt' }); break; }
      const trip = line.slice(i, i + 3);
      if (trip === '"""' || trip === "'''") {
        const end = line.indexOf(trip, i + 3);
        if (end === -1) { tokens.push({ t: line.slice(i), cls: 'tok-str' }); inTriple = trip; break; }
        tokens.push({ t: line.slice(i, end + 3), cls: 'tok-str' });
        i = end + 3;
        continue;
      }
      if (c === '"' || c === "'") {
        const q = c;
        let j = i + 1;
        while (j < line.length && line[j] !== q) { if (line[j] === '\\') j++; j++; }
        tokens.push({ t: line.slice(i, Math.min(j + 1, line.length)), cls: 'tok-str' });
        i = j + 1; continue;
      }
      if (/[0-9]/.test(c) && (i === 0 || !/[a-zA-Z_]/.test(line[i - 1]))) {
        let j = i; while (j < line.length && /[0-9.xXa-fA-F_]/.test(line[j])) j++;
        tokens.push({ t: line.slice(i, j), cls: 'tok-num' }); i = j; continue;
      }
      if (/[a-zA-Z_]/.test(c)) {
        let j = i; while (j < line.length && /[a-zA-Z0-9_]/.test(line[j])) j++;
        const word = line.slice(i, j);
        if (kws.has(word)) tokens.push({ t: word, cls: 'tok-kw' });
        else if (line[j] === '(') tokens.push({ t: word, cls: 'tok-fn' });
        else tokens.push({ t: word });
        i = j; continue;
      }
      if (/[{}()\[\];,.:]/.test(c)) { tokens.push({ t: c, cls: 'tok-pun' }); i++; continue; }
      if (/[+\-*/%=<>!&|^~?]/.test(c)) { tokens.push({ t: c, cls: 'tok-op' }); i++; continue; }
      tokens.push({ t: c }); i++;
    }
    return tokens;
  });
}

function tokenizeSh(lines) {
  const kws = new Set(KEYWORDS.sh);
  return lines.map((line) => {
    const tokens = [];
    let i = 0;
    if (line.startsWith('#!')) { tokens.push({ t: line, cls: 'tok-cmt' }); return tokens; }
    while (i < line.length) {
      const c = line[i];
      if (c === '#') { tokens.push({ t: line.slice(i), cls: 'tok-cmt' }); break; }
      if (c === '"' || c === "'") {
        const q = c;
        let j = i + 1;
        while (j < line.length && line[j] !== q) { if (line[j] === '\\') j++; j++; }
        tokens.push({ t: line.slice(i, Math.min(j + 1, line.length)), cls: 'tok-str' });
        i = j + 1; continue;
      }
      if (c === '$') {
        let j = i + 1;
        if (line[j] === '{') { while (j < line.length && line[j] !== '}') j++; j++; }
        else while (j < line.length && /[a-zA-Z0-9_]/.test(line[j])) j++;
        tokens.push({ t: line.slice(i, j), cls: 'tok-var' }); i = j; continue;
      }
      if (/[a-zA-Z_]/.test(c)) {
        let j = i; while (j < line.length && /[a-zA-Z0-9_-]/.test(line[j])) j++;
        const word = line.slice(i, j);
        if (kws.has(word)) tokens.push({ t: word, cls: 'tok-kw' });
        else tokens.push({ t: word });
        i = j; continue;
      }
      if (/[0-9]/.test(c)) {
        let j = i; while (j < line.length && /[0-9.]/.test(line[j])) j++;
        tokens.push({ t: line.slice(i, j), cls: 'tok-num' }); i = j; continue;
      }
      if (/[|&;<>(){}\[\]]/.test(c)) { tokens.push({ t: c, cls: 'tok-pun' }); i++; continue; }
      tokens.push({ t: c }); i++;
    }
    return tokens;
  });
}

function tokenizeCss(lines) {
  // jednoduchý: vně bloku = selektor; uvnitř = key: value;
  let inBlock = false;
  let inComment = false;
  return lines.map((line) => {
    const tokens = [];
    let i = 0;
    if (inComment) {
      const end = line.indexOf('*/');
      if (end === -1) { tokens.push({ t: line, cls: 'tok-cmt' }); return tokens; }
      tokens.push({ t: line.slice(0, end + 2), cls: 'tok-cmt' });
      i = end + 2;
      inComment = false;
    }
    while (i < line.length) {
      const c = line[i];
      if (c === '/' && line[i + 1] === '*') {
        const end = line.indexOf('*/', i + 2);
        if (end === -1) { tokens.push({ t: line.slice(i), cls: 'tok-cmt' }); inComment = true; break; }
        tokens.push({ t: line.slice(i, end + 2), cls: 'tok-cmt' }); i = end + 2; continue;
      }
      if (c === '{') { tokens.push({ t: c, cls: 'tok-pun' }); inBlock = true; i++; continue; }
      if (c === '}') { tokens.push({ t: c, cls: 'tok-pun' }); inBlock = false; i++; continue; }
      if (c === '"' || c === "'") {
        const q = c; let j = i + 1;
        while (j < line.length && line[j] !== q) { if (line[j] === '\\') j++; j++; }
        tokens.push({ t: line.slice(i, Math.min(j + 1, line.length)), cls: 'tok-str' });
        i = j + 1; continue;
      }
      if (!inBlock) {
        // selektor až do { nebo ,
        let j = i;
        while (j < line.length && line[j] !== '{' && line[j] !== ',' && !(line[j] === '/' && line[j + 1] === '*')) j++;
        const seg = line.slice(i, j);
        // rozlišit . # @ : tag
        if (seg.trim()) tokens.push({ t: seg, cls: 'tok-sel' });
        else tokens.push({ t: seg });
        i = j; continue;
      }
      // uvnitř bloku: key : value ;
      if (/[a-zA-Z-]/.test(c)) {
        let j = i; while (j < line.length && /[a-zA-Z0-9_-]/.test(line[j])) j++;
        const word = line.slice(i, j);
        let k = j;
        while (line[k] === ' ' || line[k] === '\t') k++;
        if (line[k] === ':') tokens.push({ t: word, cls: 'tok-prop' });
        else tokens.push({ t: word, cls: 'tok-val' });
        i = j; continue;
      }
      if (c === ':') {
        tokens.push({ t: c, cls: 'tok-pun' });
        // až do ; nebo konce
        let j = i + 1; while (j < line.length && line[j] !== ';' && line[j] !== '}') j++;
        const val = line.slice(i + 1, j);
        if (val) tokens.push({ t: val, cls: 'tok-val' });
        i = j; continue;
      }
      if (/[;,{}()]/.test(c)) { tokens.push({ t: c, cls: 'tok-pun' }); i++; continue; }
      tokens.push({ t: c }); i++;
    }
    return tokens;
  });
}

function tokenizeHtml(lines) {
  let inTag = false;
  let inComment = false;
  return lines.map((line) => {
    const tokens = [];
    let i = 0;
    while (i < line.length) {
      if (inComment) {
        const end = line.indexOf('-->', i);
        if (end === -1) { tokens.push({ t: line.slice(i), cls: 'tok-cmt' }); inComment = true; break; }
        tokens.push({ t: line.slice(i, end + 3), cls: 'tok-cmt' });
        i = end + 3; inComment = false; continue;
      }
      if (!inTag) {
        if (line.startsWith('<!--', i)) {
          const end = line.indexOf('-->', i + 4);
          if (end === -1) { tokens.push({ t: line.slice(i), cls: 'tok-cmt' }); inComment = true; break; }
          tokens.push({ t: line.slice(i, end + 3), cls: 'tok-cmt' }); i = end + 3; continue;
        }
        if (line[i] === '<') {
          inTag = true;
          // <tagname
          let j = i + 1;
          if (line[j] === '/') j++;
          let s = j;
          while (j < line.length && /[a-zA-Z0-9-]/.test(line[j])) j++;
          tokens.push({ t: line.slice(i, s), cls: 'tok-pun' });
          if (j > s) tokens.push({ t: line.slice(s, j), cls: 'tok-tag' });
          i = j; continue;
        }
        // plain text
        let j = i; while (j < line.length && line[j] !== '<') j++;
        tokens.push({ t: line.slice(i, j) });
        i = j; continue;
      }
      // uvnitř tagu
      if (line[i] === '>') { tokens.push({ t: '>', cls: 'tok-pun' }); inTag = false; i++; continue; }
      if (line[i] === '/' && line[i + 1] === '>') { tokens.push({ t: '/>', cls: 'tok-pun' }); inTag = false; i += 2; continue; }
      if (line[i] === ' ' || line[i] === '\t') { tokens.push({ t: line[i] }); i++; continue; }
      if (line[i] === '=') { tokens.push({ t: '=', cls: 'tok-op' }); i++; continue; }
      if (line[i] === '"' || line[i] === "'") {
        const q = line[i]; let j = i + 1;
        while (j < line.length && line[j] !== q) j++;
        tokens.push({ t: line.slice(i, Math.min(j + 1, line.length)), cls: 'tok-str' });
        i = j + 1; continue;
      }
      // attribut
      let j = i; while (j < line.length && /[a-zA-Z0-9_:-]/.test(line[j])) j++;
      if (j > i) { tokens.push({ t: line.slice(i, j), cls: 'tok-attr' }); i = j; continue; }
      tokens.push({ t: line[i] }); i++;
    }
    return tokens;
  });
}

function tokenizeJson(lines) {
  let stringDepth = 0; // JSON nemá multi-line stringy, ale pro jistotu
  return lines.map((line) => {
    const tokens = [];
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      if (c === '"') {
        let j = i + 1;
        while (j < line.length && line[j] !== '"') { if (line[j] === '\\') j++; j++; }
        // klíč jestli za zavřením je dvojtečka
        let k = j + 1;
        while (line[k] === ' ' || line[k] === '\t') k++;
        const isKey = line[k] === ':';
        tokens.push({ t: line.slice(i, Math.min(j + 1, line.length)), cls: isKey ? 'tok-key' : 'tok-str' });
        i = j + 1; continue;
      }
      if (/[0-9-]/.test(c)) {
        let j = i; while (j < line.length && /[0-9.eE+-]/.test(line[j])) j++;
        tokens.push({ t: line.slice(i, j), cls: 'tok-num' }); i = j; continue;
      }
      if (/[a-z]/.test(c)) {
        let j = i; while (j < line.length && /[a-z]/.test(line[j])) j++;
        const w = line.slice(i, j);
        if (w === 'true' || w === 'false' || w === 'null') tokens.push({ t: w, cls: 'tok-kw' });
        else tokens.push({ t: w });
        i = j; continue;
      }
      if (/[{}\[\],:]/.test(c)) { tokens.push({ t: c, cls: 'tok-pun' }); i++; continue; }
      tokens.push({ t: c }); i++;
    }
    return tokens;
  });
}

function tokenizeYaml(lines) {
  return lines.map((line) => {
    const tokens = [];
    if (line.trim().startsWith('#')) { tokens.push({ t: line, cls: 'tok-cmt' }); return tokens; }
    if (line.trim() === '---' || line.trim() === '...') { tokens.push({ t: line, cls: 'tok-pun' }); return tokens; }
    // klíč: hodnota
    const m = /^(\s*-?\s*)([A-Za-z_][\w-]*)(\s*:\s*)(.*)$/.exec(line);
    if (m) {
      tokens.push({ t: m[1] });
      tokens.push({ t: m[2], cls: 'tok-key' });
      tokens.push({ t: m[3], cls: 'tok-pun' });
      if (m[4]) tokens.push({ t: m[4], cls: 'tok-val' });
      return tokens;
    }
    tokens.push({ t: line });
    return tokens;
  });
}

function tokenizeMd(lines) {
  let inFence = false;
  return lines.map((line) => {
    const tokens = [];
    if (/^```/.test(line)) { tokens.push({ t: line, cls: 'tok-md-fence' }); inFence = !inFence; return tokens; }
    if (inFence) { tokens.push({ t: line, cls: 'tok-md-code' }); return tokens; }
    if (/^#{1,6}\s/.test(line)) { tokens.push({ t: line, cls: 'tok-md-h' }); return tokens; }
    if (/^\s*[-*+]\s/.test(line)) {
      const m = /^(\s*)([-*+]\s)(.*)$/.exec(line);
      tokens.push({ t: m[1] });
      tokens.push({ t: m[2], cls: 'tok-md-bullet' });
      pushInline(tokens, m[3]);
      return tokens;
    }
    if (/^\s*>/.test(line)) { tokens.push({ t: line, cls: 'tok-md-quote' }); return tokens; }
    if (/^---+$/.test(line.trim()) || /^===+$/.test(line.trim())) { tokens.push({ t: line, cls: 'tok-md-rule' }); return tokens; }
    pushInline(tokens, line);
    return tokens;
  });

  function pushInline(tokens, line) {
    // jednoduché: regex přes inline elementy v pořadí, zbytek zachovává délky.
    const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)|(\[[^\]]+\]\([^)]+\))/g;
    let last = 0;
    let m;
    while ((m = re.exec(line))) {
      if (m.index > last) tokens.push({ t: line.slice(last, m.index) });
      const s = m[0];
      let cls = 'tok-md-em';
      if (s.startsWith('`')) cls = 'tok-md-code';
      else if (s.startsWith('**') || s.startsWith('__')) cls = 'tok-md-bold';
      else if (s.startsWith('[')) cls = 'tok-md-link';
      tokens.push({ t: s, cls });
      last = m.index + s.length;
    }
    if (last < line.length) tokens.push({ t: line.slice(last) });
  }
}

const TOKENIZERS = {
  js: tokenizeJs,
  py: tokenizePy,
  sh: tokenizeSh,
  css: tokenizeCss,
  html: tokenizeHtml,
  json: tokenizeJson,
  yaml: tokenizeYaml,
  toml: tokenizeYaml,
  md: tokenizeMd,
  ruby: tokenizeRuby,
  go: tokenizeGo,
  rust: tokenizeRust,
  java: tokenizeJava,
  c: tokenizeC,
  php: tokenizePhp,
  lua: tokenizeLua,
  sql: tokenizeSql,
  plain: (lines) => lines.map((l) => [{ t: l }]),
};

function renderLine(tokens) {
  let html = '';
  for (const tok of tokens) {
    const text = escapeHtml(tok.t);
    if (tok.cls) html += `<span class="${tok.cls}">${text}</span>`;
    else html += text;
  }
  return html || '&nbsp;'; // prázdný řádek = aspoň nbsp ať není zhroucený
}

// --- editor -----------------------------------------------------------------

export function mountEditor(host, opts = {}) {
  const text = opts.text || '';
  const filename = opts.filename || '';
  const lang = detectLang(filename);
  const tokenize = TOKENIZERS[lang] || TOKENIZERS.plain;

  const state = {
    lines: text.split('\n'),
    cursor: { row: 0, col: 0 },
    preferredCol: 0,
    mode: 'normal',
    visualAnchor: null,
    cmdline: '',
    cmdPrefix: '',
    pending: '',
    pendingCount: '',
    searchTerm: '',
    searchDir: 1,
    yank: { type: 'char', text: '' },
    undo: [],
    redo: [],
    dirty: false,
    msg: '',
    msgKind: '',
  };
  if (state.lines.length === 0) state.lines = [''];

  // root
  host.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'vim';
  root.tabIndex = 0;
  root.innerHTML = `
    <div class="vim__pane">
      <div class="vim__gutter" data-vim-gutter></div>
      <div class="vim__view" data-vim-view>
        <pre class="vim__buf" data-vim-buf></pre>
        <div class="vim__sel" data-vim-sel></div>
        <div class="vim__cursor" data-vim-cursor></div>
      </div>
    </div>
    <div class="vim__status" data-vim-status>
      <span class="vim__mode" data-vim-mode>NORMAL</span>
      <span class="vim__file">${escapeHtml(filename || '[no name]')}</span>
      <span class="vim__msg" data-vim-msg></span>
      <span class="vim__pos" data-vim-pos>1:1</span>
    </div>
    <div class="vim__cmdline" data-vim-cmdline></div>
  `;
  host.appendChild(root);

  const view = root.querySelector('[data-vim-view]');
  const buf = root.querySelector('[data-vim-buf]');
  const gutter = root.querySelector('[data-vim-gutter]');
  const cursorEl = root.querySelector('[data-vim-cursor]');
  const selEl = root.querySelector('[data-vim-sel]');
  const modeEl = root.querySelector('[data-vim-mode]');
  const posEl = root.querySelector('[data-vim-pos]');
  const msgEl = root.querySelector('[data-vim-msg]');
  const cmdEl = root.querySelector('[data-vim-cmdline]');

  // změřit char-width, line-height a padding view (kvůli alignmentu cursoru/sel).
  let charW = 8.4, lineH = 18, padX = 0, padY = 0;
  const measure = () => {
    const s = document.createElement('span');
    s.textContent = 'M'.repeat(20);
    s.style.position = 'absolute';
    s.style.visibility = 'hidden';
    s.style.whiteSpace = 'pre';
    buf.appendChild(s);
    const r = s.getBoundingClientRect();
    charW = r.width / 20;
    lineH = r.height;
    s.remove();
    const cs = getComputedStyle(view);
    padX = parseFloat(cs.paddingLeft) || 0;
    padY = parseFloat(cs.paddingTop) || 0;
  };

  // --- render ---------------------------------------------------------------

  function render() {
    const tokenLines = tokenize(state.lines);
    const html = tokenLines.map(renderLine).join('\n');
    buf.innerHTML = html;
    // gutter
    let g = '';
    for (let i = 0; i < state.lines.length; i++) g += `<div class="vim__gn">${i + 1}</div>`;
    gutter.innerHTML = g;
    placeCursor();
    renderSelection();
    updateStatus();
  }

  function placeCursor() {
    const { row, col } = state.cursor;
    cursorEl.style.top = `${padY + row * lineH}px`;
    cursorEl.style.left = `${padX + col * charW}px`;
    if (state.mode === 'insert') {
      cursorEl.classList.add('is-insert');
      cursorEl.classList.remove('is-block');
    } else {
      cursorEl.classList.add('is-block');
      cursorEl.classList.remove('is-insert');
    }
    cursorEl.style.width = state.mode === 'insert' ? '2px' : `${charW}px`;
    cursorEl.style.height = `${lineH}px`;
    // scroll into view
    const cTop = padY + row * lineH;
    const cBottom = cTop + lineH;
    if (cTop < view.scrollTop + padY) view.scrollTop = Math.max(0, cTop - padY);
    if (cBottom > view.scrollTop + view.clientHeight) view.scrollTop = cBottom - view.clientHeight;
    const cLeft = padX + col * charW;
    if (cLeft < view.scrollLeft) view.scrollLeft = cLeft;
    if (cLeft + charW > view.scrollLeft + view.clientWidth) view.scrollLeft = cLeft + charW - view.clientWidth;
  }

  function renderSelection() {
    if (state.mode !== 'visual' && state.mode !== 'visual-line') {
      selEl.innerHTML = '';
      return;
    }
    const range = visualRange();
    const html = [];
    if (state.mode === 'visual-line') {
      for (let r = range.startRow; r <= range.endRow; r++) {
        const lineLen = state.lines[r].length;
        const w = Math.max(lineLen, 1) * charW;
        html.push(`<div class="vim__selrect" style="top:${padY + r * lineH}px;left:${padX}px;width:${w}px;height:${lineH}px"></div>`);
      }
    } else {
      for (let r = range.startRow; r <= range.endRow; r++) {
        const lineLen = state.lines[r].length;
        let c0 = 0, c1 = lineLen;
        if (r === range.startRow) c0 = range.startCol;
        if (r === range.endRow) c1 = range.endCol + 1;
        const w = Math.max((c1 - c0), 0) * charW;
        if (w === 0) continue;
        html.push(`<div class="vim__selrect" style="top:${padY + r * lineH}px;left:${padX + c0 * charW}px;width:${w}px;height:${lineH}px"></div>`);
      }
    }
    selEl.innerHTML = html.join('');
  }

  function visualRange() {
    const a = state.visualAnchor;
    const c = state.cursor;
    if (!a) return { startRow: c.row, startCol: c.col, endRow: c.row, endCol: c.col };
    const before = (a.row < c.row) || (a.row === c.row && a.col <= c.col);
    return before
      ? { startRow: a.row, startCol: a.col, endRow: c.row, endCol: c.col }
      : { startRow: c.row, startCol: c.col, endRow: a.row, endCol: a.col };
  }

  function updateStatus() {
    const labels = { normal: 'NORMAL', insert: 'INSERT', visual: 'VISUAL', 'visual-line': 'V-LINE', command: 'COMMAND', search: 'SEARCH' };
    modeEl.textContent = labels[state.mode] || state.mode.toUpperCase();
    modeEl.dataset.mode = state.mode;
    posEl.textContent = `${state.cursor.row + 1}:${state.cursor.col + 1}`;
    msgEl.textContent = state.msg || '';
    msgEl.dataset.kind = state.msgKind || '';
    if (state.mode === 'command' || state.mode === 'search') {
      cmdEl.textContent = state.cmdPrefix + state.cmdline;
      cmdEl.classList.add('is-active');
    } else {
      cmdEl.textContent = '';
      cmdEl.classList.remove('is-active');
    }
  }

  function flash(msg, kind = '') {
    state.msg = msg;
    state.msgKind = kind;
    updateStatus();
    clearTimeout(flash._t);
    flash._t = setTimeout(() => { state.msg = ''; updateStatus(); }, 1600);
  }

  // --- buffer / cursor mutace ----------------------------------------------

  function snapshot() {
    state.undo.push({
      lines: state.lines.slice(),
      cursor: { ...state.cursor },
    });
    if (state.undo.length > 200) state.undo.shift();
    state.redo.length = 0;
  }

  function applySnapshot(snap) {
    state.lines = snap.lines.slice();
    state.cursor = { ...snap.cursor };
    clampCursor();
  }

  function clampCursor() {
    if (state.cursor.row < 0) state.cursor.row = 0;
    if (state.cursor.row > state.lines.length - 1) state.cursor.row = state.lines.length - 1;
    const max = lineMax();
    if (state.cursor.col < 0) state.cursor.col = 0;
    if (state.cursor.col > max) state.cursor.col = max;
  }

  function lineMax() {
    const lineLen = state.lines[state.cursor.row].length;
    if (state.mode === 'insert') return lineLen;
    return Math.max(0, lineLen - 1);
  }

  function notifyChange() {
    state.dirty = true;
    if (opts.onChange) opts.onChange(getText());
  }

  function getText() { return state.lines.join('\n'); }
  function setText(t) {
    state.lines = (t || '').split('\n');
    if (state.lines.length === 0) state.lines = [''];
    state.cursor = { row: 0, col: 0 };
    state.undo = []; state.redo = [];
    render();
  }

  // --- motion --------------------------------------------------------------

  function moveLeft(n = 1) {
    state.cursor.col = Math.max(0, state.cursor.col - n);
    state.preferredCol = state.cursor.col;
  }
  function moveRight(n = 1) {
    state.cursor.col = Math.min(lineMax(), state.cursor.col + n);
    state.preferredCol = state.cursor.col;
  }
  function moveUp(n = 1) {
    state.cursor.row = Math.max(0, state.cursor.row - n);
    state.cursor.col = Math.min(state.preferredCol, lineMax());
  }
  function moveDown(n = 1) {
    state.cursor.row = Math.min(state.lines.length - 1, state.cursor.row + n);
    state.cursor.col = Math.min(state.preferredCol, lineMax());
  }
  function moveLineStart() { state.cursor.col = 0; state.preferredCol = 0; }
  function moveLineFirstNonBlank() {
    const line = state.lines[state.cursor.row];
    const m = /\S/.exec(line);
    state.cursor.col = m ? m.index : 0;
    state.preferredCol = state.cursor.col;
  }
  function moveLineEnd() {
    state.cursor.col = lineMax();
    state.preferredCol = state.cursor.col;
  }
  function moveDocStart() { state.cursor.row = 0; moveLineFirstNonBlank(); }
  function moveDocEnd() { state.cursor.row = state.lines.length - 1; moveLineFirstNonBlank(); }

  const WORD_CHAR = /[A-Za-z0-9_]/;
  function classOf(ch) {
    if (!ch) return 'eol';
    if (/\s/.test(ch)) return 'ws';
    if (WORD_CHAR.test(ch)) return 'word';
    return 'punct';
  }
  function moveWordForward(n = 1, big = false) {
    for (let k = 0; k < n; k++) {
      let { row, col } = state.cursor;
      let line = state.lines[row];
      const startCls = big ? (line[col] && !/\s/.test(line[col]) ? 'word' : 'ws') : classOf(line[col]);
      // přeskoč aktuální skupinu
      while (col < line.length && (big ? !/\s/.test(line[col]) : classOf(line[col]) === startCls) && startCls !== 'ws') col++;
      // přeskoč whitespace (i přes konec řádku)
      while (true) {
        while (col < line.length && /\s/.test(line[col])) col++;
        if (col < line.length) break;
        if (row >= state.lines.length - 1) { col = line.length; break; }
        row++;
        col = 0;
        line = state.lines[row];
      }
      state.cursor = { row, col };
    }
    state.preferredCol = state.cursor.col;
  }
  function moveWordBack(n = 1, big = false) {
    for (let k = 0; k < n; k++) {
      let { row, col } = state.cursor;
      // skoč zpět minimálně o 1
      if (col === 0) {
        if (row === 0) break;
        row--; col = state.lines[row].length;
      } else col--;
      let line = state.lines[row];
      // přeskoč whitespace zpět
      while (col >= 0 && /\s/.test(line[col])) {
        col--;
        if (col < 0) {
          if (row === 0) { col = 0; break; }
          row--; line = state.lines[row]; col = line.length - 1;
        }
      }
      if (col < 0) col = 0;
      // přeskoč skupinu zpět
      const cls = big ? 'word' : classOf(line[col]);
      while (col > 0 && (big ? !/\s/.test(line[col - 1]) : classOf(line[col - 1]) === cls)) col--;
      state.cursor = { row, col };
    }
    state.preferredCol = state.cursor.col;
  }
  function moveWordEnd(n = 1, big = false) {
    for (let k = 0; k < n; k++) {
      let { row, col } = state.cursor;
      let line = state.lines[row];
      col++;
      while (col < line.length && /\s/.test(line[col])) col++;
      if (col >= line.length) {
        if (row < state.lines.length - 1) { row++; col = 0; line = state.lines[row]; while (col < line.length && /\s/.test(line[col])) col++; }
      }
      const cls = big ? 'word' : classOf(line[col]);
      while (col < line.length - 1 && (big ? !/\s/.test(line[col + 1]) : classOf(line[col + 1]) === cls)) col++;
      state.cursor = { row, col };
    }
    state.preferredCol = state.cursor.col;
  }

  // --- edit ---------------------------------------------------------------

  function insertChar(ch) {
    const { row, col } = state.cursor;
    const line = state.lines[row];
    state.lines[row] = line.slice(0, col) + ch + line.slice(col);
    state.cursor.col = col + ch.length;
    notifyChange();
  }
  function insertNewline() {
    const { row, col } = state.cursor;
    const line = state.lines[row];
    const before = line.slice(0, col);
    const after = line.slice(col);
    // auto-indent: pokračuj v leading whitespace
    const ind = /^[ \t]*/.exec(before)[0];
    state.lines.splice(row, 1, before, ind + after);
    state.cursor = { row: row + 1, col: ind.length };
    notifyChange();
  }
  function backspaceChar() {
    const { row, col } = state.cursor;
    if (col > 0) {
      const line = state.lines[row];
      state.lines[row] = line.slice(0, col - 1) + line.slice(col);
      state.cursor.col = col - 1;
    } else if (row > 0) {
      const prev = state.lines[row - 1];
      const cur = state.lines[row];
      state.lines.splice(row - 1, 2, prev + cur);
      state.cursor = { row: row - 1, col: prev.length };
    } else return;
    notifyChange();
  }
  function deleteChar(n = 1) {
    const { row, col } = state.cursor;
    const line = state.lines[row];
    const del = line.slice(col, col + n);
    if (!del.length) return;
    state.yank = { type: 'char', text: del };
    state.lines[row] = line.slice(0, col) + line.slice(col + n);
    clampCursor();
    notifyChange();
  }
  function deleteCharBefore(n = 1) {
    const { row, col } = state.cursor;
    if (col === 0) return;
    const k = Math.min(n, col);
    const line = state.lines[row];
    state.yank = { type: 'char', text: line.slice(col - k, col) };
    state.lines[row] = line.slice(0, col - k) + line.slice(col);
    state.cursor.col = col - k;
    notifyChange();
  }
  function deleteLines(start, end) {
    const { row } = state.cursor;
    const arr = state.lines.slice(start, end + 1);
    state.yank = { type: 'line', text: arr.join('\n') + '\n' };
    state.lines.splice(start, end - start + 1);
    if (state.lines.length === 0) state.lines = [''];
    state.cursor.row = Math.min(start, state.lines.length - 1);
    moveLineFirstNonBlank();
    notifyChange();
  }
  function yankLines(start, end) {
    const arr = state.lines.slice(start, end + 1);
    state.yank = { type: 'line', text: arr.join('\n') + '\n' };
  }
  function yankRange(range) {
    const lines = [];
    for (let r = range.startRow; r <= range.endRow; r++) {
      const line = state.lines[r];
      let c0 = 0, c1 = line.length;
      if (r === range.startRow) c0 = range.startCol;
      if (r === range.endRow) c1 = range.endCol + 1;
      lines.push(line.slice(c0, c1));
    }
    state.yank = { type: 'char', text: lines.join('\n') };
  }
  function deleteRange(range) {
    yankRange(range);
    const before = state.lines[range.startRow].slice(0, range.startCol);
    const after = state.lines[range.endRow].slice(range.endCol + 1);
    state.lines.splice(range.startRow, range.endRow - range.startRow + 1, before + after);
    state.cursor = { row: range.startRow, col: range.startCol };
    clampCursor();
    notifyChange();
  }
  function paste(after = true) {
    const y = state.yank;
    if (!y || !y.text) return;
    if (y.type === 'line') {
      const insertAt = after ? state.cursor.row + 1 : state.cursor.row;
      const parts = y.text.replace(/\n$/, '').split('\n');
      state.lines.splice(insertAt, 0, ...parts);
      state.cursor.row = insertAt;
      moveLineFirstNonBlank();
    } else {
      const { row, col } = state.cursor;
      const line = state.lines[row];
      const at = after ? col + (line.length ? 1 : 0) : col;
      const parts = y.text.split('\n');
      if (parts.length === 1) {
        state.lines[row] = line.slice(0, at) + parts[0] + line.slice(at);
        state.cursor.col = at + parts[0].length - 1;
      } else {
        const first = line.slice(0, at) + parts[0];
        const lastPart = parts[parts.length - 1] + line.slice(at);
        const mid = parts.slice(1, -1);
        state.lines.splice(row, 1, first, ...mid, lastPart);
        state.cursor = { row: row + parts.length - 1, col: parts[parts.length - 1].length - 1 };
      }
      clampCursor();
    }
    notifyChange();
  }
  function openLineBelow() {
    const { row } = state.cursor;
    const line = state.lines[row];
    const ind = /^[ \t]*/.exec(line)[0];
    state.lines.splice(row + 1, 0, ind);
    state.cursor = { row: row + 1, col: ind.length };
    setMode('insert');
    notifyChange();
  }
  function openLineAbove() {
    const { row } = state.cursor;
    const line = state.lines[row];
    const ind = /^[ \t]*/.exec(line)[0];
    state.lines.splice(row, 0, ind);
    state.cursor = { row, col: ind.length };
    setMode('insert');
    notifyChange();
  }

  function setMode(m) {
    if (m === 'normal' && state.mode === 'insert') {
      // vim: po Esc kurzor o 1 doleva
      if (state.cursor.col > 0) state.cursor.col -= 1;
    }
    if (m === 'visual') state.visualAnchor = { ...state.cursor };
    else if (m === 'visual-line') state.visualAnchor = { ...state.cursor };
    else state.visualAnchor = null;
    state.mode = m;
    clampCursor();
  }

  // --- search --------------------------------------------------------------

  function doSearch(term, dir, fromHere = false) {
    if (!term) return false;
    state.searchTerm = term;
    state.searchDir = dir;
    const total = state.lines.length;
    let { row, col } = state.cursor;
    if (!fromHere) col += dir; // ať /n posune dál
    for (let k = 0; k < total + 1; k++) {
      const line = state.lines[row] || '';
      if (dir === 1) {
        const idx = line.indexOf(term, Math.max(col, 0));
        if (idx !== -1) { state.cursor = { row, col: idx }; state.preferredCol = idx; return true; }
        row = (row + 1) % total; col = 0;
      } else {
        const upTo = col >= 0 ? line.slice(0, col) : '';
        const idx = upTo.lastIndexOf(term);
        if (idx !== -1) { state.cursor = { row, col: idx }; state.preferredCol = idx; return true; }
        row = (row - 1 + total) % total;
        col = (state.lines[row] || '').length;
      }
    }
    return false;
  }

  // --- key handling --------------------------------------------------------

  function handleNormal(e) {
    const key = e.key;
    if (key === 'Escape') {
      state.pending = ''; state.pendingCount = '';
      render(); return true;
    }

    // sběr počtu (1-9, pak 0 = část čísla když už začalo)
    if (/^[0-9]$/.test(key) && (key !== '0' || state.pendingCount)) {
      state.pendingCount += key;
      render(); return true;
    }

    const count = parseInt(state.pendingCount || '1', 10);

    // pending: gg / dd / yy / d{motion} / y{motion} / c{motion}
    if (state.pending) {
      const p = state.pending;
      state.pending = '';
      if (p === 'g' && key === 'g') {
        snapshot();
        moveDocStart();
      } else if (p === 'd') {
        if (key === 'd') {
          snapshot();
          const r0 = state.cursor.row;
          deleteLines(r0, Math.min(state.lines.length - 1, r0 + count - 1));
        } else if (key === 'w') { snapshot(); const a = { ...state.cursor }; moveWordForward(count); deleteRange(rangeBetween(a, state.cursor)); }
        else if (key === '$') { snapshot(); const a = { ...state.cursor }; moveLineEnd(); deleteRange(rangeBetween(a, state.cursor)); }
        else if (key === '0') { snapshot(); const a = { ...state.cursor }; moveLineStart(); deleteRange(rangeBetween(state.cursor, a)); }
      } else if (p === 'y') {
        if (key === 'y') {
          const r0 = state.cursor.row;
          yankLines(r0, Math.min(state.lines.length - 1, r0 + count - 1));
          flash(`${Math.min(count, state.lines.length - r0)} lines yanked`);
        } else if (key === 'w') { const a = { ...state.cursor }; moveWordForward(count); yankRange(rangeBetween(a, state.cursor)); state.cursor = a; }
      } else if (p === 'c') {
        if (key === 'c') {
          snapshot();
          const r0 = state.cursor.row;
          deleteLines(r0, Math.min(state.lines.length - 1, r0 + count - 1));
          openLineAbove();
          // openLineAbove už vlozí prazdny radek + nastaví insert; ale chci nahradit zrušený řádek
          state.lines.splice(state.cursor.row + 1, 1); // odstraň duplicitní
        } else if (key === 'w') { snapshot(); const a = { ...state.cursor }; moveWordForward(count); deleteRange(rangeBetween(a, state.cursor)); setMode('insert'); }
        else if (key === '$') { snapshot(); const a = { ...state.cursor }; moveLineEnd(); deleteRange(rangeBetween(a, state.cursor)); setMode('insert'); }
      } else if (p === 'r') {
        // replace one char
        if (key.length === 1) {
          snapshot();
          const { row, col } = state.cursor;
          const line = state.lines[row];
          if (col < line.length) {
            state.lines[row] = line.slice(0, col) + key + line.slice(col + 1);
            notifyChange();
          }
        }
      }
      state.pendingCount = '';
      render(); return true;
    }

    // count reset po neprefixové akci
    const reset = () => { state.pendingCount = ''; };

    switch (key) {
      case 'h': case 'ArrowLeft': moveLeft(count); reset(); break;
      case 'l': case 'ArrowRight': moveRight(count); reset(); break;
      case 'j': case 'ArrowDown': moveDown(count); reset(); break;
      case 'k': case 'ArrowUp': moveUp(count); reset(); break;
      case 'w': moveWordForward(count, e.shiftKey); reset(); break;
      case 'W': moveWordForward(count, true); reset(); break;
      case 'b': moveWordBack(count, e.shiftKey); reset(); break;
      case 'B': moveWordBack(count, true); reset(); break;
      case 'e': moveWordEnd(count, false); reset(); break;
      case 'E': moveWordEnd(count, true); reset(); break;
      case '0': moveLineStart(); reset(); break;
      case '^': moveLineFirstNonBlank(); reset(); break;
      case '$': moveLineEnd(); reset(); break;
      case 'g': state.pending = 'g'; break;
      case 'G': {
        if (state.pendingCount) { state.cursor.row = Math.min(state.lines.length - 1, count - 1); moveLineFirstNonBlank(); }
        else moveDocEnd();
        reset(); break;
      }
      case 'i': setMode('insert'); reset(); break;
      case 'I': moveLineFirstNonBlank(); setMode('insert'); reset(); break;
      case 'a': state.cursor.col = Math.min(state.lines[state.cursor.row].length, state.cursor.col + 1); setMode('insert'); reset(); break;
      case 'A': state.cursor.col = state.lines[state.cursor.row].length; setMode('insert'); reset(); break;
      case 'o': snapshot(); openLineBelow(); reset(); break;
      case 'O': snapshot(); openLineAbove(); reset(); break;
      case 'x': snapshot(); deleteChar(count); reset(); break;
      case 'X': snapshot(); deleteCharBefore(count); reset(); break;
      case 'd': state.pending = 'd'; break;
      case 'y': state.pending = 'y'; break;
      case 'c': state.pending = 'c'; break;
      case 'r': state.pending = 'r'; break;
      case 'D': { snapshot(); const a = { ...state.cursor }; moveLineEnd(); deleteRange(rangeBetween(a, state.cursor)); reset(); break; }
      case 'C': { snapshot(); const a = { ...state.cursor }; moveLineEnd(); deleteRange(rangeBetween(a, state.cursor)); setMode('insert'); reset(); break; }
      case 'Y': { yankLines(state.cursor.row, state.cursor.row); flash('1 line yanked'); reset(); break; }
      case 'p': snapshot(); paste(true); reset(); break;
      case 'P': snapshot(); paste(false); reset(); break;
      case 'u': {
        if (state.undo.length) {
          state.redo.push({ lines: state.lines.slice(), cursor: { ...state.cursor } });
          applySnapshot(state.undo.pop());
          notifyChange();
        } else flash('Already at oldest change');
        reset(); break;
      }
      case 'v': setMode('visual'); reset(); break;
      case 'V': setMode('visual-line'); reset(); break;
      case '/': state.cmdline = ''; state.cmdPrefix = '/'; setMode('search'); reset(); break;
      case '?': state.cmdline = ''; state.cmdPrefix = '?'; state.searchDir = -1; setMode('search'); reset(); break;
      case 'n': if (state.searchTerm) doSearch(state.searchTerm, state.searchDir); reset(); break;
      case 'N': if (state.searchTerm) doSearch(state.searchTerm, -state.searchDir); reset(); break;
      case ':': state.cmdline = ''; state.cmdPrefix = ':'; setMode('command'); reset(); break;
      case 'Enter': moveDown(1); moveLineFirstNonBlank(); reset(); break;
      case ' ': moveRight(count); reset(); break;
      default:
        if (e.ctrlKey && key === 'r') {
          if (state.redo.length) {
            state.undo.push({ lines: state.lines.slice(), cursor: { ...state.cursor } });
            applySnapshot(state.redo.pop());
            notifyChange();
          } else flash('Already at newest change');
          reset();
        } else {
          return false;
        }
    }
    return true;
  }

  function rangeBetween(a, b) {
    const before = (a.row < b.row) || (a.row === b.row && a.col <= b.col);
    return before
      ? { startRow: a.row, startCol: a.col, endRow: b.row, endCol: Math.max(0, b.col - 1) }
      : { startRow: b.row, startCol: b.col, endRow: a.row, endCol: Math.max(0, a.col - 1) };
  }

  function handleInsert(e) {
    if (e.key === 'Escape') { setMode('normal'); return true; }
    if (e.key === 'Enter') { snapshot(); insertNewline(); return true; }
    if (e.key === 'Backspace') { snapshot(); backspaceChar(); return true; }
    if (e.key === 'Tab') { snapshot(); insertChar('  '); return true; }
    if (e.key === 'ArrowLeft') { moveLeft(); return true; }
    if (e.key === 'ArrowRight') { state.cursor.col = Math.min(state.lines[state.cursor.row].length, state.cursor.col + 1); return true; }
    if (e.key === 'ArrowUp') { moveUp(); return true; }
    if (e.key === 'ArrowDown') { moveDown(); return true; }
    if (e.key === 'Home') { moveLineStart(); return true; }
    if (e.key === 'End') { state.cursor.col = state.lines[state.cursor.row].length; return true; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      snapshot();
      insertChar(e.key);
      return true;
    }
    return false;
  }

  function handleVisual(e) {
    const key = e.key;
    if (key === 'Escape' || key === 'v' && state.mode === 'visual' || key === 'V' && state.mode === 'visual-line') {
      setMode('normal'); return true;
    }
    if (key === 'v' && state.mode === 'visual-line') { setMode('visual'); state.visualAnchor = { ...(state.visualAnchor || state.cursor) }; return true; }
    if (key === 'V' && state.mode === 'visual') { setMode('visual-line'); return true; }
    // motion
    const count = parseInt(state.pendingCount || '1', 10);
    let moved = false;
    switch (key) {
      case 'h': case 'ArrowLeft': moveLeft(count); moved = true; break;
      case 'l': case 'ArrowRight': moveRight(count); moved = true; break;
      case 'j': case 'ArrowDown': moveDown(count); moved = true; break;
      case 'k': case 'ArrowUp': moveUp(count); moved = true; break;
      case 'w': moveWordForward(count); moved = true; break;
      case 'b': moveWordBack(count); moved = true; break;
      case '0': moveLineStart(); moved = true; break;
      case '^': moveLineFirstNonBlank(); moved = true; break;
      case '$': moveLineEnd(); moved = true; break;
      case 'g': if (state.pending === 'g') { moveDocStart(); state.pending = ''; moved = true; } else state.pending = 'g'; break;
      case 'G': moveDocEnd(); moved = true; break;
      case 'y': {
        if (state.mode === 'visual-line') {
          yankLines(Math.min(state.visualAnchor.row, state.cursor.row), Math.max(state.visualAnchor.row, state.cursor.row));
        } else {
          yankRange(visualRange());
        }
        flash('yanked');
        setMode('normal');
        return true;
      }
      case 'd': case 'x': {
        snapshot();
        if (state.mode === 'visual-line') {
          deleteLines(Math.min(state.visualAnchor.row, state.cursor.row), Math.max(state.visualAnchor.row, state.cursor.row));
        } else {
          deleteRange(visualRange());
        }
        setMode('normal');
        return true;
      }
      case 'c': {
        snapshot();
        if (state.mode === 'visual-line') {
          deleteLines(Math.min(state.visualAnchor.row, state.cursor.row), Math.max(state.visualAnchor.row, state.cursor.row));
          openLineAbove();
          state.lines.splice(state.cursor.row + 1, 1);
        } else {
          deleteRange(visualRange());
          setMode('insert');
        }
        return true;
      }
      default:
        if (/^[0-9]$/.test(key)) { state.pendingCount += key; return true; }
        return false;
    }
    if (moved) { state.pendingCount = ''; return true; }
    return false;
  }

  function handleCommand(e) {
    if (e.key === 'Escape') { setMode('normal'); state.cmdline = ''; return true; }
    if (e.key === 'Enter') {
      runCommand(state.cmdline);
      state.cmdline = '';
      // runCommand může nastavit mode
      if (state.mode === 'command') setMode('normal');
      return true;
    }
    if (e.key === 'Backspace') {
      if (state.cmdline.length === 0) { setMode('normal'); return true; }
      state.cmdline = state.cmdline.slice(0, -1);
      return true;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      state.cmdline += e.key;
      return true;
    }
    return false;
  }

  function handleSearch(e) {
    if (e.key === 'Escape') { setMode('normal'); state.cmdline = ''; return true; }
    if (e.key === 'Enter') {
      const dir = state.cmdPrefix === '?' ? -1 : 1;
      const ok = doSearch(state.cmdline, dir, true);
      setMode('normal');
      if (!ok) flash(`Pattern not found: ${state.cmdline}`, 'err');
      return true;
    }
    if (e.key === 'Backspace') {
      if (state.cmdline.length === 0) { setMode('normal'); return true; }
      state.cmdline = state.cmdline.slice(0, -1);
      return true;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      state.cmdline += e.key;
      return true;
    }
    return false;
  }

  function runCommand(cmd) {
    cmd = cmd.trim();
    if (!cmd) return;
    if (cmd === 'w') { if (opts.onSave) opts.onSave(getText()); flash('written'); return; }
    if (cmd === 'q') { if (opts.onClose) opts.onClose(); return; }
    if (cmd === 'wq' || cmd === 'x') { if (opts.onSave) opts.onSave(getText()); if (opts.onClose) opts.onClose(); return; }
    if (cmd === 'q!') { if (opts.onClose) opts.onClose(); return; }
    if (/^\d+$/.test(cmd)) {
      state.cursor.row = Math.min(state.lines.length - 1, parseInt(cmd, 10) - 1);
      moveLineFirstNonBlank();
      return;
    }
    if (cmd === 'set nu' || cmd === 'set number') { root.classList.add('vim--num'); return; }
    if (cmd === 'set nonu' || cmd === 'set nonumber') { root.classList.remove('vim--num'); return; }
    flash(`E492: Not an editor command: ${cmd}`, 'err');
  }

  // --- listeners -----------------------------------------------------------

  function onKeydown(e) {
    // ignoruj modifier-only události
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;

    // Cmd+S / Ctrl+S: save (i v insert mode)
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault(); e.stopPropagation();
      if (opts.onSave) opts.onSave(getText());
      flash('written');
      render();
      return;
    }

    let handled = false;
    if (state.mode === 'normal') handled = handleNormal(e);
    else if (state.mode === 'insert') handled = handleInsert(e);
    else if (state.mode === 'visual' || state.mode === 'visual-line') handled = handleVisual(e);
    else if (state.mode === 'command') handled = handleCommand(e);
    else if (state.mode === 'search') handled = handleSearch(e);

    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      clampCursor();
      render();
    }
  }

  function onClick(e) {
    // klik = umísti kurzor v normal/insert (v insert mode necháváme insert)
    const rect = view.getBoundingClientRect();
    const x = e.clientX - rect.left + view.scrollLeft - padX;
    const y = e.clientY - rect.top + view.scrollTop - padY;
    const row = Math.max(0, Math.min(state.lines.length - 1, Math.floor(y / lineH)));
    const col = Math.max(0, Math.round(x / charW));
    const max = state.lines[row].length;
    state.cursor = { row, col: Math.min(col, state.mode === 'insert' ? max : Math.max(0, max - 1)) };
    state.preferredCol = state.cursor.col;
    render();
    root.focus();
  }

  root.addEventListener('keydown', onKeydown);
  view.addEventListener('click', onClick);
  root.addEventListener('focus', () => root.classList.add('is-focused'));
  root.addEventListener('blur', () => root.classList.remove('is-focused'));

  measure();
  render();

  return {
    focus() { root.focus(); },
    destroy() {
      root.removeEventListener('keydown', onKeydown);
      view.removeEventListener('click', onClick);
      host.removeChild(root);
    },
    getText, setText,
    isDirty() { return state.dirty; },
  };
}
