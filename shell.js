// Mini shell: session state + tokenizer + dispatch na built-in příkazy.
// Iterace 1: jen jeden příkaz na řádek, žádné pipes / redirekce / proměnné.
// Iterace 3 přidá pipes, redirekce, $VAR, $(...), &&/||/;.

import { BUILTINS } from './shell-builtins.js';

export function createSession(opts = {}) {
  return {
    id: opts.id || String(Date.now()),
    cwd: opts.cwd || '',
    env: Object.assign(
      { HOME: '~', PATH: '/builtin', PS1: '~/$ ' },
      opts.env || {},
    ),
    history: [],
    aliases: {},
  };
}

// Tokenizer respektuje 'single', "double" uvozovky a \ escape.
// Mimo uvozovky se whitespace splituje, single quotes neexpandují escape.
export function tokenize(line) {
  const tokens = [];
  let cur = '';
  let started = false;
  let inS = false;
  let inD = false;
  const push = () => { if (started) { tokens.push(cur); cur = ''; started = false; } };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inS) {
      if (c === "'") { inS = false; }
      else { cur += c; started = true; }
      continue;
    }
    if (inD) {
      if (c === '"') { inD = false; }
      else if (c === '\\' && i + 1 < line.length) { cur += line[++i]; started = true; }
      else { cur += c; started = true; }
      continue;
    }
    if (c === "'") { inS = true; started = true; continue; }
    if (c === '"') { inD = true; started = true; continue; }
    if (c === '\\' && i + 1 < line.length) { cur += line[++i]; started = true; continue; }
    if (c === ' ' || c === '\t') { push(); continue; }
    cur += c; started = true;
  }
  push();
  return tokens;
}

export async function execLine(line, session, io) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return 0;
  // komentář
  if (trimmed.startsWith('#')) return 0;
  const tokens = tokenize(trimmed);
  if (!tokens.length) return 0;
  const [cmd, ...args] = tokens;
  const fn = BUILTINS[cmd];
  if (!fn) {
    io.stderr(`${cmd}: příkaz nenalezen. Zkuste \`help\`.`);
    return 127;
  }
  try {
    const code = await fn(args, session, io);
    return typeof code === 'number' ? code : 0;
  } catch (e) {
    io.stderr(`${cmd}: ${e && e.message ? e.message : String(e)}`);
    return 1;
  }
}
