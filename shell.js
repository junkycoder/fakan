// Mini shell: session + tokenizer + parser + executor.
// Iterace 1: jeden příkaz.
// Iterace 2: zápis (FS přes shell-fs).
// Iterace 3: pipes (|), redirekce (>, >>, <), &&/||/;, $VAR expanze.
// Iterace 4: multiline + for/if/while + glob (*, ?), bash skripty.

import { BUILTINS } from './shell-builtins.js';
import { readFile, writeFile, resolvePath, stat, readdir, exists } from './shell-fs.js';

export function createSession(opts = {}) {
  return {
    id: opts.id || String(Date.now()),
    cwd: opts.cwd || '',
    env: Object.assign(
      { HOME: '~', PATH: '/builtin', PS1: '~/$ ', '?': '0' },
      opts.env || {},
    ),
    history: [],
    aliases: {},
  };
}

// --- tokenizer -------------------------------------------------------------
// Token: { kind: 'op', value } | { kind: 'word', parts, hadSingle, hadDouble }
// part: { text, expand } — expand:true znamená že $VAR a glob expandují
//                         expand:false (single quote) znamená literal
// Expanze $VAR i glob proběhne až při exec time (after tokenize). To je
// kritické pro `for x in ...; do echo $x; done` — $x se musí expandnout
// po každé iteraci.

const KEYWORDS = new Set([
  'for', 'in', 'do', 'done',
  'if', 'then', 'else', 'elif', 'fi',
  'while', 'until',
  'function',
]);

export function tokenize(line) {
  const out = [];
  let parts = [];
  let cur = '';
  let curExpand = true;
  let started = false;
  let hadSingle = false;
  let hadDouble = false;
  let inS = false;
  let inD = false;

  const flushPart = () => {
    if (cur !== '') { parts.push({ text: cur, expand: curExpand }); cur = ''; }
  };
  const setMode = (expand) => {
    if (curExpand !== expand) { flushPart(); curExpand = expand; }
  };
  const pushWord = () => {
    flushPart();
    if (started) {
      out.push({ kind: 'word', parts, hadSingle, hadDouble });
      parts = []; started = false; hadSingle = false; hadDouble = false; curExpand = true;
    }
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const c2 = line[i + 1];

    if (inS) {
      if (c === "'") { inS = false; setMode(true); }
      else { cur += c; started = true; }
      continue;
    }
    if (inD) {
      if (c === '"') { inD = false; }
      else if (c === '\\' && c2 === '$') {
        // literal $ — escape do segmentu s expand:false, ať ho VAR_RE neexpanduje znovu
        const wasExpand = curExpand;
        setMode(false); cur += '$'; flushPart(); curExpand = wasExpand;
        i++; started = true;
      }
      else if (c === '\\' && (c2 === '"' || c2 === '\\')) {
        cur += c2; i++; started = true;
      }
      else { cur += c; started = true; }
      continue;
    }

    if (c === "'") { setMode(false); hadSingle = true; inS = true; started = true; continue; }
    if (c === '"') { hadDouble = true; inD = true; started = true; continue; }

    // line continuation
    if (c === '\\' && c2 === '\n') { i++; continue; }
    if (c === '\\' && c2 != null) { cur += c2; i++; started = true; continue; }

    // operátory
    if (c === '|' && c2 === '|') { pushWord(); out.push({ kind: 'op', value: '||' }); i++; continue; }
    if (c === '&' && c2 === '&') { pushWord(); out.push({ kind: 'op', value: '&&' }); i++; continue; }
    if (c === '>' && c2 === '>') { pushWord(); out.push({ kind: 'op', value: '>>' }); i++; continue; }
    if (c === '|') { pushWord(); out.push({ kind: 'op', value: '|' }); continue; }
    if (c === ';') { pushWord(); out.push({ kind: 'op', value: ';' }); continue; }
    if (c === '>') { pushWord(); out.push({ kind: 'op', value: '>' }); continue; }
    if (c === '<') { pushWord(); out.push({ kind: 'op', value: '<' }); continue; }

    if (c === '\n') { pushWord(); out.push({ kind: 'op', value: ';' }); continue; }
    if (c === ' ' || c === '\t') { pushWord(); continue; }

    // komentář # na začátku slova
    if (c === '#' && !started) {
      while (i < line.length && line[i] !== '\n') i++;
      i--;
      continue;
    }

    cur += c; started = true;
  }
  pushWord();
  return out;
}

// --- expanze tokenů --------------------------------------------------------
// expandToken vrátí finální string s expandovanými $VAR / ${VAR} podle env.
// Aplikuje se až při exec-time, aby for/while smyčky viděly aktuální hodnoty.

const VAR_RE = /\$\{([A-Za-z_?][A-Za-z0-9_]*)\}|\$([A-Za-z_?][A-Za-z0-9_]*)/g;

export function expandToken(token, env) {
  if (!token.parts || !token.parts.length) return '';
  return token.parts.map((p) => {
    if (!p.expand) return p.text;
    return p.text.replace(VAR_RE, (_, a, b) => {
      const name = a || b;
      const v = env[name];
      return v == null ? '' : String(v);
    });
  }).join('');
}

// Pro snadné použití parserem — slovní tokeny se rovnají literálnímu jménu
// (např. keyword `for`) jen tehdy, pokud nebyly v žádných uvozovkách. To
// kopíruje bash chování: `'for'` je literal, ne keyword.
function tokenLiteral(t) {
  if (t.kind !== 'word') return null;
  if (t.hadSingle || t.hadDouble) return null;
  // pouze plain ASCII identifikátor → keyword candidate
  let s = '';
  for (const p of t.parts) {
    if (!p.expand) return null; // má single segment
    s += p.text;
  }
  return s;
}

// --- glob expanze ----------------------------------------------------------
// `*` a `?` v unquoted tokenu se expandují proti VFS. Pokud match nic nenajde,
// token zůstane jak je (bash chování nullglob=off).

function looksLikeGlob(s) { return /[*?]/.test(s); }

function globToRegex(glob) {
  let s = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') s += '[^/]*';
    else if (c === '?') s += '[^/]';
    else if (/[.+^${}()|[\]\\]/.test(c)) s += '\\' + c;
    else s += c;
  }
  s += '$';
  return new RegExp(s);
}

// Glob expanze pracuje na finálním textu (po $VAR expanzi). Pokud token byl
// (i částečně) v single quote, glob neexpanduje — část s expand:false
// zachovává literální `*` / `?`.
function tokenHasGlobChars(token) {
  for (const p of token.parts || []) {
    if (!p.expand) continue;
    if (looksLikeGlob(p.text)) return true;
  }
  return false;
}

function expandGlobsForArgv(tokens, env, session) {
  const out = [];
  for (const t of tokens) {
    const text = expandToken(t, env);
    if (!tokenHasGlobChars(t)) { out.push(text); continue; }
    const slash = text.lastIndexOf('/');
    const dirPart = slash >= 0 ? text.slice(0, slash) : '';
    const pat = slash >= 0 ? text.slice(slash + 1) : text;
    if (!looksLikeGlob(pat)) { out.push(text); continue; }
    const dirAbs = dirPart
      ? resolvePath(session.cwd, dirPart)
      : (session.cwd || '');
    const entries = readdir(dirAbs);
    if (!entries) { out.push(text); continue; }
    const re = globToRegex(pat);
    const matches = entries
      .filter((e) => re.test(e.name))
      .filter((e) => pat.startsWith('.') || !e.name.startsWith('.'))
      .map((e) => dirPart ? `${dirPart}/${e.name}` : e.name)
      .sort();
    if (!matches.length) { out.push(text); continue; }
    for (const m of matches) out.push(m);
  }
  return out;
}

// --- parser ----------------------------------------------------------------
// Statement = { kind: 'compound' | 'for' | 'while' | 'if' }
// Compound = { kind: 'compound', parts: [{ pipeline, conn }] }
// Pipeline = [Command]
// Command = { argTokens: [token], redirIn?: token, redirOut?: { token, append } }
// For      = { kind: 'for', var, wordTokens, body: [Statement] }
// While    = { kind: 'while', test: [Statement], body: [Statement] }
// If       = { kind: 'if', branches: [{ test, body }], elseBody }
//
// Tokeny zůstávají v AST a expandují se až při exec — kvůli for/while
// smyčkám, kde $var dostává novou hodnotu mezi iteracemi.

function newCmd() {
  return { argTokens: [], redirIn: undefined, redirOut: undefined };
}

function isOp(t, op) {
  return t && t.kind === 'op' && t.value === op;
}

function skipSemis(tokens, i) {
  while (i < tokens.length && isOp(tokens[i], ';')) i++;
  return i;
}

function isKeyword(t, kw) {
  return t && t.kind === 'word' && tokenLiteral(t) === kw;
}

export function parseScript(tokens) {
  const stmts = [];
  let i = skipSemis(tokens, 0);
  while (i < tokens.length) {
    const r = parseStatement(tokens, i, null);
    stmts.push(r.stmt);
    i = skipSemis(tokens, r.next);
  }
  return stmts;
}

function parseStatement(tokens, start, stopWords) {
  const first = tokens[start];
  if (first && first.kind === 'word') {
    const lit = tokenLiteral(first);
    if (lit === 'for')   return parseFor(tokens, start);
    if (lit === 'if')    return parseIf(tokens, start);
    if (lit === 'while') return parseWhile(tokens, start);
  }
  return parseCompoundUntil(tokens, start, stopWords);
}

function parseCompoundUntil(tokens, start, stopWords) {
  const parts = [];
  let pipeline = [];
  let cmd = newCmd();
  let conn = 'start';
  let i = start;

  const finishCmd = () => {
    if (cmd.argTokens.length) { pipeline.push(cmd); cmd = newCmd(); return true; }
    return false;
  };
  const finishPipeline = (nextConn) => {
    finishCmd();
    if (pipeline.length) { parts.push({ pipeline, conn }); pipeline = []; }
    conn = nextConn;
  };

  while (i < tokens.length) {
    const t = tokens[i];
    if (t.kind === 'op') {
      if (t.value === ';')  { finishPipeline(';'); i++; if (!cmd.argTokens.length && !pipeline.length) break; continue; }
      if (t.value === '&&') { finishPipeline('&&'); i++; continue; }
      if (t.value === '||') { finishPipeline('||'); i++; continue; }
      if (t.value === '|') {
        if (!cmd.argTokens.length) throw new Error('prázdný příkaz před `|`');
        pipeline.push(cmd); cmd = newCmd(); i++; continue;
      }
      if (t.value === '>' || t.value === '>>' || t.value === '<') {
        const next = tokens[i + 1];
        if (!next || next.kind !== 'word') throw new Error(`${t.value} čeká cestu`);
        if (t.value === '<') cmd.redirIn = next;
        else cmd.redirOut = { token: next, append: t.value === '>>' };
        i += 2; continue;
      }
    } else {
      const lit = tokenLiteral(t);
      if (stopWords && lit != null && stopWords.has(lit) && !cmd.argTokens.length && !pipeline.length) {
        break;
      }
      cmd.argTokens.push(t);
      i++;
    }
  }
  finishPipeline('end');
  return { stmt: { kind: 'compound', parts }, next: i };
}

function parseFor(tokens, start) {
  let i = start + 1;
  const varTok = tokens[i++];
  const varName = varTok && varTok.kind === 'word' ? tokenLiteral(varTok) : null;
  if (!varName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
    throw new Error('for: očekáván název proměnné');
  }
  const inTok = tokens[i++];
  if (!isKeyword(inTok, 'in')) throw new Error("for: očekáván 'in'");
  const wordTokens = [];
  while (i < tokens.length) {
    const t = tokens[i];
    if (isOp(t, ';')) { i++; break; }
    if (isKeyword(t, 'do')) break;
    if (t.kind === 'word') { wordTokens.push(t); i++; continue; }
    throw new Error(`for: neočekávaný token`);
  }
  i = skipSemis(tokens, i);
  const doTok = tokens[i++];
  if (!isKeyword(doTok, 'do')) throw new Error("for: očekáván 'do'");
  const { body, next } = parseBlock(tokens, i, new Set(['done']));
  const endTok = tokens[next];
  if (!isKeyword(endTok, 'done')) throw new Error("for: chybí 'done'");
  return { stmt: { kind: 'for', var: varName, wordTokens, body }, next: next + 1 };
}

function parseWhile(tokens, start) {
  let i = start + 1;
  const testRes = parseBlock(tokens, i, new Set(['do']));
  i = testRes.next;
  const doTok = tokens[i++];
  if (!isKeyword(doTok, 'do')) throw new Error("while: očekáván 'do'");
  const bodyRes = parseBlock(tokens, i, new Set(['done']));
  i = bodyRes.next;
  const endTok = tokens[i++];
  if (!isKeyword(endTok, 'done')) throw new Error("while: chybí 'done'");
  return { stmt: { kind: 'while', test: testRes.body, body: bodyRes.body }, next: i };
}

function parseIf(tokens, start) {
  let i = start + 1;
  const branches = [];
  let elseBody = null;
  while (true) {
    const testRes = parseBlock(tokens, i, new Set(['then']));
    i = testRes.next;
    const thenTok = tokens[i++];
    if (!isKeyword(thenTok, 'then')) throw new Error("if: očekáván 'then'");
    const bodyRes = parseBlock(tokens, i, new Set(['elif', 'else', 'fi']));
    branches.push({ test: testRes.body, body: bodyRes.body });
    i = bodyRes.next;
    const cont = tokens[i];
    if (!cont) throw new Error("if: chybí 'fi'");
    const lit = tokenLiteral(cont);
    if (lit === 'elif') { i++; continue; }
    if (lit === 'else') {
      i++;
      const elseRes = parseBlock(tokens, i, new Set(['fi']));
      elseBody = elseRes.body;
      i = elseRes.next;
    }
    const fiTok = tokens[i++];
    if (!isKeyword(fiTok, 'fi')) throw new Error("if: chybí 'fi'");
    break;
  }
  return { stmt: { kind: 'if', branches, elseBody }, next: i };
}

function parseBlock(tokens, start, stopWords) {
  const body = [];
  let i = skipSemis(tokens, start);
  while (i < tokens.length) {
    const t = tokens[i];
    const lit = t.kind === 'word' ? tokenLiteral(t) : null;
    if (lit != null && stopWords.has(lit)) break;
    const r = parseStatement(tokens, i, stopWords);
    body.push(r.stmt);
    i = skipSemis(tokens, r.next);
  }
  return { body, next: i };
}

// --- executor --------------------------------------------------------------

function makeCollector() {
  let buf = '';
  return {
    io: {
      stdout: (t) => {
        if (t == null) return;
        const s = String(t);
        buf += s;
        if (!s.endsWith('\n')) buf += '\n';
      },
      stderr: null,
      clear: () => { buf = ''; },
      close: () => {},
    },
    get text() { return buf.replace(/\n$/, ''); },
  };
}

async function execCommand(cmd, session, io) {
  if (!cmd.argTokens.length) return 0;
  // expanze + glob na argv až tady
  const argv = expandGlobsForArgv(cmd.argTokens, session.env, session);
  if (!argv.length) return 0;
  const [name, ...args] = argv;

  if (name.startsWith('./') || name.startsWith('/') || name.startsWith('../')) {
    const p = resolvePath(session.cwd, name);
    const s = stat(p);
    if (s && s.type === 'file') {
      return runScriptFile(p, args, session, io);
    }
    if (s && s.type === 'dir') { io.stderr(`${name}: je adresář`); return 126; }
    io.stderr(`${name}: nic takového`); return 127;
  }

  const fn = BUILTINS[name];
  if (!fn) {
    io.stderr(`${name}: příkaz nenalezen. Zkuste \`help\`.`);
    return 127;
  }
  try {
    const code = await fn(args, session, io);
    return typeof code === 'number' ? code : 0;
  } catch (e) {
    io.stderr(`${name}: ${e && e.message ? e.message : String(e)}`);
    return 1;
  }
}

async function execPipeline(pipeline, session, hostIO) {
  let stdin = '';
  let lastCode = 0;
  for (let i = 0; i < pipeline.length; i++) {
    const cmd = pipeline[i];
    const isLast = i === pipeline.length - 1;

    if (cmd.redirIn) {
      const inText = expandToken(cmd.redirIn, session.env);
      const inPath = resolvePath(session.cwd, inText);
      const text = await readFile(inPath);
      if (text == null) {
        hostIO.stderr(`${inText}: nelze otevřít`);
        return 1;
      }
      stdin = text;
    }

    const needsCollector = !isLast || cmd.redirOut;
    let collector = null;
    let cmdIO;
    if (needsCollector) {
      collector = makeCollector();
      cmdIO = {
        stdout: collector.io.stdout,
        stderr: (t) => hostIO.stderr(t),
        clear: () => hostIO.clear(),
        close: () => hostIO.close(),
        stdin, isatty: false,
      };
    } else {
      cmdIO = {
        stdout: (t) => hostIO.stdout(t),
        stderr: (t) => hostIO.stderr(t),
        clear: () => hostIO.clear(),
        close: () => hostIO.close(),
        stdin, isatty: true,
      };
    }

    lastCode = await execCommand(cmd, session, cmdIO);

    if (collector && cmd.redirOut) {
      const outText = expandToken(cmd.redirOut.token, session.env);
      const outPath = resolvePath(session.cwd, outText);
      let content = collector.text;
      if (cmd.redirOut.append) {
        const prev = await readFile(outPath);
        content = (prev != null ? prev : '') + (prev && !prev.endsWith('\n') ? '\n' : '') + content;
      }
      try { writeFile(outPath, content); }
      catch (e) { hostIO.stderr(`redirect: ${e.message || e}`); lastCode = 1; }
      stdin = '';
    } else if (collector) {
      stdin = collector.text;
    }
  }
  return lastCode;
}

async function execCompound(stmt, session, io) {
  let lastCode = 0;
  for (const { pipeline, conn } of stmt.parts) {
    if (conn === '&&' && lastCode !== 0) continue;
    if (conn === '||' && lastCode === 0) continue;
    lastCode = await execPipeline(pipeline, session, io);
    session.env['?'] = String(lastCode);
  }
  return lastCode;
}

async function execStatement(stmt, session, io) {
  if (stmt.kind === 'compound') return execCompound(stmt, session, io);
  if (stmt.kind === 'for')      return execFor(stmt, session, io);
  if (stmt.kind === 'while')    return execWhile(stmt, session, io);
  if (stmt.kind === 'if')       return execIf(stmt, session, io);
  throw new Error(`neznámý stmt: ${stmt.kind}`);
}

async function execBlock(body, session, io) {
  let last = 0;
  for (const s of body) {
    last = await execStatement(s, session, io);
    session.env['?'] = String(last);
  }
  return last;
}

async function execFor(stmt, session, io) {
  let last = 0;
  // Expand words at for-time (po vstupu do for, ale ne po každé iteraci —
  // bash chování). Glob expanze taky tady. Token za tokenem.
  const words = expandGlobsForArgv(stmt.wordTokens, session.env, session);
  for (const w of words) {
    session.env[stmt.var] = w;
    last = await execBlock(stmt.body, session, io);
  }
  return last;
}

async function execWhile(stmt, session, io) {
  let last = 0;
  let guard = 0;
  while (true) {
    const testCode = await execBlock(stmt.test, session, io);
    if (testCode !== 0) break;
    last = await execBlock(stmt.body, session, io);
    if (++guard > 10000) { io.stderr('while: limit 10000 iterací'); return 1; }
  }
  return last;
}

async function execIf(stmt, session, io) {
  for (const br of stmt.branches) {
    const testCode = await execBlock(br.test, session, io);
    if (testCode === 0) return execBlock(br.body, session, io);
  }
  if (stmt.elseBody) return execBlock(stmt.elseBody, session, io);
  return 0;
}

// --- script runner ---------------------------------------------------------

async function runScriptFile(scriptPath, args, session, io) {
  const text = await readFile(scriptPath);
  if (text == null) { io.stderr(`${scriptPath}: nelze přečíst`); return 1; }
  // pozičcní parametry $1, $2, ...
  const savedEnv = {};
  args.forEach((v, idx) => {
    const k = String(idx + 1);
    savedEnv[k] = session.env[k];
    session.env[k] = v;
  });
  savedEnv['#'] = session.env['#'];
  session.env['#'] = String(args.length);
  try {
    return await runScriptText(text, session, io);
  } finally {
    for (const k of Object.keys(savedEnv)) {
      if (savedEnv[k] === undefined) delete session.env[k];
      else session.env[k] = savedEnv[k];
    }
  }
}

export async function runScriptText(text, session, io) {
  let tokens;
  try { tokens = tokenize(text); }
  catch (e) { io.stderr(`syntax: ${e.message || e}`); return 2; }

  let stmts;
  try { stmts = parseScript(tokens); }
  catch (e) { io.stderr(`syntax: ${e.message || e}`); return 2; }

  let last = 0;
  for (const s of stmts) {
    last = await execStatement(s, session, io);
    session.env['?'] = String(last);
  }
  return last;
}

// Eviduji v shell-builtins jako built-in: bash <script> -> načti text + run.
export const SCRIPT_RUNNERS = { runScriptFile, runScriptText };

// --- public entry point ----------------------------------------------------

export async function execLine(line, session, io) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return 0;
  if (trimmed.startsWith('#')) return 0;
  return runScriptText(trimmed, session, io);
}
