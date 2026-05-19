// Mini shell: session + tokenizer + parser + executor.
// Iterace 1: jeden příkaz.
// Iterace 2: zápis (FS přes shell-fs).
// Iterace 3: pipes (|), redirekce (>, >>, <), &&/||/;, $VAR expanze.

import { BUILTINS } from './shell-builtins.js';
import { readFile, writeFile, resolvePath } from './shell-fs.js';

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
// Vrací pole tokenů. Operátory (|, ||, &&, ;, >, >>, <) jsou vlastní tokeny.
// $VAR a ${VAR} se expandují podle session.env mimo single quotes.
// Single quotes literally; double quotes ano expanze $VAR i \" escape.
//
// Token: { kind: 'word' | 'op', value: string }. Pro 'word' value je už po expanzi.

const OPS = ['||', '&&', '>>', '|', ';', '>', '<'];

function isVarChar(c) {
  return /[A-Za-z0-9_]/.test(c);
}

function expandVar(text, env) {
  // $VAR nebo ${VAR}. Neznámé vrátí prázdno (bash chování).
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_?][A-Za-z0-9_]*)/g,
    (_, a, b) => {
      const name = a || b;
      const v = env[name];
      return v == null ? '' : String(v);
    });
}

export function tokenize(line, env = {}) {
  const out = [];
  let cur = '';
  let started = false;
  let inS = false;
  let inD = false;
  const pushWord = () => {
    if (started) {
      out.push({ kind: 'word', value: cur });
      cur = '';
      started = false;
    }
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const c2 = line[i + 1];

    if (inS) {
      if (c === "'") { inS = false; }
      else { cur += c; started = true; }
      continue;
    }
    if (inD) {
      if (c === '"') { inD = false; }
      else if (c === '\\' && c2 != null) { cur += c2; i++; started = true; }
      else if (c === '$') {
        // expanze v double quotes
        const m = matchVar(line, i);
        if (m) { cur += lookup(m.name, env); i += m.len - 1; started = true; }
        else { cur += c; started = true; }
      }
      else { cur += c; started = true; }
      continue;
    }

    // mimo uvozovky
    if (c === "'") { inS = true; started = true; continue; }
    if (c === '"') { inD = true; started = true; continue; }
    if (c === '\\' && c2 != null) { cur += c2; i++; started = true; continue; }

    // operátory
    if (c === '|' && c2 === '|') { pushWord(); out.push({ kind: 'op', value: '||' }); i++; continue; }
    if (c === '&' && c2 === '&') { pushWord(); out.push({ kind: 'op', value: '&&' }); i++; continue; }
    if (c === '>' && c2 === '>') { pushWord(); out.push({ kind: 'op', value: '>>' }); i++; continue; }
    if (c === '|') { pushWord(); out.push({ kind: 'op', value: '|' }); continue; }
    if (c === ';') { pushWord(); out.push({ kind: 'op', value: ';' }); continue; }
    if (c === '>') { pushWord(); out.push({ kind: 'op', value: '>' }); continue; }
    if (c === '<') { pushWord(); out.push({ kind: 'op', value: '<' }); continue; }

    if (c === ' ' || c === '\t') { pushWord(); continue; }

    if (c === '$') {
      const m = matchVar(line, i);
      if (m) { cur += lookup(m.name, env); i += m.len - 1; started = true; continue; }
    }

    cur += c; started = true;
  }
  pushWord();
  return out;
}

function matchVar(line, i) {
  // $name
  let m = /^\$([A-Za-z_?][A-Za-z0-9_]*)/.exec(line.slice(i));
  if (m) return { name: m[1], len: m[0].length };
  // ${name}
  m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(line.slice(i));
  if (m) return { name: m[1], len: m[0].length };
  return null;
}

function lookup(name, env) {
  const v = env[name];
  return v == null ? '' : String(v);
}

// --- parser ----------------------------------------------------------------
// Compound = parts ([{ pipeline, conn }], conn ∈ { 'start', ';', '&&', '||' })
// Pipeline = [Command]
// Command = { argv: [string], redirIn?: string, redirOut?: { path, append } }

export function parse(tokens) {
  const parts = [];
  let pipeline = [];
  let cmd = newCmd();
  let conn = 'start';

  const finishCmd = () => {
    if (cmd.argv.length) { pipeline.push(cmd); cmd = newCmd(); return true; }
    return cmd.argv.length > 0;
  };
  const finishPipeline = (nextConn) => {
    finishCmd();
    if (pipeline.length) {
      parts.push({ pipeline, conn });
      pipeline = [];
    }
    conn = nextConn;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'op') {
      if (t.value === ';') { finishPipeline(';'); continue; }
      if (t.value === '&&') { finishPipeline('&&'); continue; }
      if (t.value === '||') { finishPipeline('||'); continue; }
      if (t.value === '|') {
        if (!cmd.argv.length) throw new Error('syntax: prázdný příkaz před `|`');
        pipeline.push(cmd);
        cmd = newCmd();
        continue;
      }
      if (t.value === '>' || t.value === '>>' || t.value === '<') {
        const next = tokens[i + 1];
        if (!next || next.kind !== 'word') throw new Error(`syntax: ${t.value} čeká cestu`);
        i++;
        if (t.value === '<') cmd.redirIn = next.value;
        else cmd.redirOut = { path: next.value, append: t.value === '>>' };
        continue;
      }
    } else {
      cmd.argv.push(t.value);
    }
  }
  finishPipeline('end');
  return parts;
}

function newCmd() {
  return { argv: [], redirIn: undefined, redirOut: undefined };
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
      stderr: null, // přepíše executor odkazem na hostIO.stderr
      clear: () => { buf = ''; },
      close: () => {},
    },
    get text() { return buf.replace(/\n$/, ''); },
  };
}

async function execCommand(cmd, session, io) {
  if (!cmd.argv.length) return 0;
  const [name, ...args] = cmd.argv;
  // alias rozpracujeme v iteraci 6
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

    // redirekce in má přednost před pipe-feed
    if (cmd.redirIn) {
      const inPath = resolvePath(session.cwd, cmd.redirIn);
      const text = await readFile(inPath);
      if (text == null) {
        hostIO.stderr(`${cmd.argv[0]}: ${cmd.redirIn}: nelze otevřít`);
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
        stdin,
        isatty: false,
      };
    } else {
      cmdIO = {
        stdout: (t) => hostIO.stdout(t),
        stderr: (t) => hostIO.stderr(t),
        clear: () => hostIO.clear(),
        close: () => hostIO.close(),
        stdin,
        isatty: true,
      };
    }

    lastCode = await execCommand(cmd, session, cmdIO);

    if (collector && cmd.redirOut) {
      const outPath = resolvePath(session.cwd, cmd.redirOut.path);
      let content = collector.text;
      if (cmd.redirOut.append) {
        const prev = await readFile(outPath);
        content = (prev != null ? prev : '') + (prev && !prev.endsWith('\n') ? '\n' : '') + content;
      }
      try { writeFile(outPath, content); }
      catch (e) { hostIO.stderr(`redirect: ${e.message || e}`); lastCode = 1; }
      stdin = ''; // poslední cmd s redirektem nepokračuje
    } else if (collector) {
      stdin = collector.text;
    }
  }
  return lastCode;
}

export async function execLine(line, session, io) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return 0;
  if (trimmed.startsWith('#')) return 0;

  let tokens;
  try { tokens = tokenize(trimmed, session.env); }
  catch (e) { io.stderr(`syntax: ${e.message || e}`); return 2; }

  let parts;
  try { parts = parse(tokens); }
  catch (e) { io.stderr(`syntax: ${e.message || e}`); return 2; }

  let lastCode = 0;
  for (const { pipeline, conn } of parts) {
    if (conn === '&&' && lastCode !== 0) continue;
    if (conn === '||' && lastCode === 0) continue;
    lastCode = await execPipeline(pipeline, session, io);
    session.env['?'] = String(lastCode);
  }
  return lastCode;
}
