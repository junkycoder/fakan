// Built-in příkazy. Iterace 1: pwd, cd, ls, cat, echo, clear, help, exit.
// Write příkazy (mkdir, touch, rm, mv, cp) přijdou v iteraci 2.

import {
  resolvePath, stat, readdir, readFile, exists, isDir, normalizeCwd,
  mkdir, mkdirP, touchFile, removePath, writeFile, copyFile, movePath,
} from './shell-fs.js';

function fmtCwd(cwd) {
  const c = normalizeCwd(cwd);
  return c ? `~/${c}` : '~/';
}

// Sdílený helper pro head / tail.
async function readSlice(files, n, name, session, io) {
  if (n <= 0) return 0;
  async function emit(text) {
    const lines = text.split('\n');
    // pokud text končí newline, split vyrobí trailing '' — odřízneme
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const slice = name === 'head' ? lines.slice(0, n) : lines.slice(-n);
    for (const ln of slice) io.stdout(ln);
  }
  if (!files.length) {
    if (io.stdin == null) { io.stderr(`${name}: chybí soubor a žádný vstup`); return 1; }
    await emit(io.stdin);
    return 0;
  }
  let code = 0;
  const showHeader = files.length > 1;
  let first = true;
  for (const f of files) {
    const p = resolvePath(session.cwd, f);
    const s = stat(p);
    if (!s) { io.stderr(`${name}: ${f}: nic takového`); code = 1; continue; }
    if (s.type !== 'file') { io.stderr(`${name}: ${f}: je adresář`); code = 1; continue; }
    const text = await readFile(p);
    if (text == null) { io.stderr(`${name}: ${f}: nelze přečíst`); code = 1; continue; }
    if (showHeader) {
      if (!first) io.stdout('');
      io.stdout(`==> ${f} <==`);
    }
    first = false;
    await emit(text);
  }
  return code;
}

export const BUILTINS = {
  pwd(args, session, io) {
    io.stdout(fmtCwd(session.cwd));
    return 0;
  },

  cd(args, session, io) {
    const target = args[0] != null ? args[0] : '';
    const next = resolvePath(session.cwd, target);
    if (next && !exists(next)) {
      io.stderr(`cd: ${target}: cesta neexistuje`);
      return 1;
    }
    if (next && !isDir(next)) {
      io.stderr(`cd: ${target}: není adresář`);
      return 1;
    }
    session.cwd = next;
    return 0;
  },

  ls(args, session, io) {
    const showAll = args.some((a) => /^-[al]*a[al]*$/.test(a));
    const longFmt = args.some((a) => /^-[al]*l[al]*$/.test(a));
    const positional = args.filter((a) => !a.startsWith('-'));
    const target = positional[0] != null
      ? resolvePath(session.cwd, positional[0])
      : (session.cwd || '');
    if (target && !exists(target)) {
      io.stderr(`ls: ${positional[0]}: nic takového`);
      return 1;
    }
    const s = stat(target);
    if (s && s.type === 'file') {
      io.stdout(s.name);
      return 0;
    }
    const entries = readdir(target) || [];
    const filtered = entries
      .filter((e) => showAll || !e.name.startsWith('.'))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    if (!filtered.length) return 0;
    const formatted = filtered
      .map((e) => e.type === 'dir' ? `${e.name}/` : e.name);
    // pokud nejsme v TTY (= pipe / redirect) anebo -l: one-per-line; jinak space-separated
    if (longFmt) {
      for (const e of filtered) {
        const mark = e.type === 'dir' ? 'd' : '-';
        io.stdout(`${mark} ${e.name}${e.type === 'dir' ? '/' : ''}`);
      }
    } else if (io.isatty === false) {
      for (const f of formatted) io.stdout(f);
    } else {
      io.stdout(formatted.join('  '));
    }
    return 0;
  },

  async cat(args, session, io) {
    const positional = args.filter((a) => !a.startsWith('-') || a === '-');
    if (!positional.length || positional.every((a) => a === '-')) {
      // čti stdin
      if (io.stdin != null) { io.stdout(io.stdin); return 0; }
      io.stderr('cat: chybí argument a žádný vstup');
      return 1;
    }
    let code = 0;
    for (const arg of positional) {
      if (arg === '-') {
        if (io.stdin != null) io.stdout(io.stdin);
        continue;
      }
      const p = resolvePath(session.cwd, arg);
      const s = stat(p);
      if (!s) { io.stderr(`cat: ${arg}: nic takového`); code = 1; continue; }
      if (s.type !== 'file') { io.stderr(`cat: ${arg}: je adresář`); code = 1; continue; }
      const text = await readFile(p);
      if (text == null) { io.stderr(`cat: ${arg}: nelze přečíst`); code = 1; continue; }
      io.stdout(text);
    }
    return code;
  },

  echo(args, session, io) {
    io.stdout(args.join(' '));
    return 0;
  },

  clear(args, session, io) {
    io.clear();
    return 0;
  },

  help(args, session, io) {
    const cmds = Object.keys(BUILTINS).sort();
    io.stdout('Příkazy:');
    io.stdout('  ' + cmds.join('  '));
    io.stdout('');
    io.stdout('Čtení:    pwd  cd  ls (-a/-l)  cat  echo  head  tail  wc');
    io.stdout('Zápis:    mkdir (-p)  touch  rm (-r/-f)  cp  mv');
    io.stdout('Filtry:   grep (-i/-v/-n/-c)  find (-name/-type)');
    io.stdout('Roury:    cmd1 | cmd2  ·  cmd > file  ·  cmd >> file  ·  cmd < file');
    io.stdout('Logika:   cmd1 && cmd2  ·  cmd1 || cmd2  ·  cmd1 ; cmd2');
    io.stdout('Proměnné: $VAR, ${VAR}, $? (poslední exit code)');
    io.stdout('');
    io.stdout('Brzy: .sh skripty (for/if), fakan příkazy (open, vim, dock).');
    return 0;
  },

  exit(args, session, io) {
    io.close();
    return 0;
  },

  true() { return 0; },
  false() { return 1; },

  env(args, session, io) {
    const keys = Object.keys(session.env).sort();
    for (const k of keys) io.stdout(`${k}=${session.env[k]}`);
    return 0;
  },

  mkdir(args, session, io) {
    const recursive = args.includes('-p');
    const paths = args.filter((a) => !a.startsWith('-'));
    if (!paths.length) {
      io.stderr('mkdir: chybí argument');
      return 1;
    }
    let code = 0;
    for (const arg of paths) {
      const p = resolvePath(session.cwd, arg);
      try {
        if (recursive) mkdirP(p);
        else {
          const res = mkdir(p);
          if (!res.created) {
            // existující dir při bez -p je chyba; mkdir() vrací reason='existuje'
            io.stderr(`mkdir: ${arg}: již existuje`);
            code = 1;
          }
        }
      } catch (e) {
        io.stderr(`mkdir: ${arg}: ${e.message || e}`);
        code = 1;
      }
    }
    return code;
  },

  touch(args, session, io) {
    const paths = args.filter((a) => !a.startsWith('-'));
    if (!paths.length) {
      io.stderr('touch: chybí argument');
      return 1;
    }
    let code = 0;
    for (const arg of paths) {
      const p = resolvePath(session.cwd, arg);
      try { touchFile(p); }
      catch (e) { io.stderr(`touch: ${arg}: ${e.message || e}`); code = 1; }
    }
    return code;
  },

  rm(args, session, io) {
    const recursive = args.some((a) => /^-[rf]*r[rf]*$/.test(a) || a === '-rf' || a === '-fr');
    const force = args.some((a) => /^-[rf]*f[rf]*$/.test(a));
    const paths = args.filter((a) => !a.startsWith('-'));
    if (!paths.length) {
      io.stderr('rm: chybí argument');
      return 1;
    }
    let code = 0;
    for (const arg of paths) {
      const p = resolvePath(session.cwd, arg);
      if (!exists(p)) {
        if (!force) { io.stderr(`rm: ${arg}: neexistuje`); code = 1; }
        continue;
      }
      try { removePath(p, { recursive }); }
      catch (e) { io.stderr(`rm: ${arg}: ${e.message || e}`); code = 1; }
    }
    return code;
  },

  async cp(args, session, io) {
    const recursive = args.some((a) => /^-[rR]$/.test(a));
    const positional = args.filter((a) => !a.startsWith('-'));
    if (positional.length < 2) {
      io.stderr('cp: očekávám zdroj a cíl');
      return 1;
    }
    const dstArg = positional.pop();
    const dst = resolvePath(session.cwd, dstArg);
    let code = 0;
    for (const srcArg of positional) {
      const src = resolvePath(session.cwd, srcArg);
      const s = stat(src);
      if (!s) { io.stderr(`cp: ${srcArg}: neexistuje`); code = 1; continue; }
      if (s.type === 'dir' && !recursive) {
        io.stderr(`cp: ${srcArg}: je adresář (přidejte -r)`);
        code = 1;
        continue;
      }
      if (s.type === 'dir') {
        // rekurze adresářů: čekám si na iteraci 3 (zatím no-op s chybou)
        io.stderr(`cp -r: zatím nepodporováno`);
        code = 1;
        continue;
      }
      // pokud dst je dir, výsledek je dst/basename(src)
      let target = dst;
      if (exists(dst) && isDir(dst)) {
        const base = src.split('/').pop();
        target = dst ? `${dst}/${base}` : base;
      }
      try { await copyFile(src, target); }
      catch (e) { io.stderr(`cp: ${srcArg}: ${e.message || e}`); code = 1; }
    }
    return code;
  },

  async grep(args, session, io) {
    let i = 0;
    const flags = { i: false, v: false, n: false, c: false };
    while (i < args.length && args[i].startsWith('-') && args[i] !== '-') {
      const a = args[i];
      if (a === '--') { i++; break; }
      for (const ch of a.slice(1)) {
        if (ch in flags) flags[ch] = true;
        else { io.stderr(`grep: neznámý flag -${ch}`); return 2; }
      }
      i++;
    }
    const pattern = args[i++];
    if (pattern == null) {
      io.stderr('grep: chybí pattern');
      return 2;
    }
    const files = args.slice(i);
    const re = new RegExp(pattern, flags.i ? 'i' : '');
    const showHeader = files.length > 1;

    async function searchText(text, source) {
      const lines = text.split('\n');
      let matched = 0;
      for (let n = 0; n < lines.length; n++) {
        const ln = lines[n];
        const m = re.test(ln);
        if (m !== flags.v) {
          matched++;
          if (flags.c) continue;
          let out = ln;
          if (flags.n) out = `${n + 1}:${out}`;
          if (showHeader && source) out = `${source}:${out}`;
          io.stdout(out);
        }
      }
      if (flags.c) {
        const out = showHeader && source ? `${source}:${matched}` : String(matched);
        io.stdout(out);
      }
      return matched;
    }

    if (!files.length) {
      if (io.stdin == null) { io.stderr('grep: chybí soubor a žádný vstup'); return 2; }
      const m = await searchText(io.stdin, '');
      return m > 0 ? 0 : 1;
    }
    let any = 0;
    let code = 0;
    for (const f of files) {
      const p = resolvePath(session.cwd, f);
      const s = stat(p);
      if (!s) { io.stderr(`grep: ${f}: nic takového`); code = 2; continue; }
      if (s.type !== 'file') { io.stderr(`grep: ${f}: je adresář`); code = 2; continue; }
      const text = await readFile(p);
      if (text == null) { io.stderr(`grep: ${f}: nelze přečíst`); code = 2; continue; }
      any += await searchText(text, f);
    }
    if (code === 0 && any === 0) code = 1;
    return code;
  },

  find(args, session, io) {
    let i = 0;
    const targets = [];
    while (i < args.length && !args[i].startsWith('-')) {
      targets.push(args[i]); i++;
    }
    if (!targets.length) targets.push('.');
    const opts = { name: null, type: null, maxdepth: Infinity };
    while (i < args.length) {
      const a = args[i];
      if (a === '-name') { opts.name = args[++i]; }
      else if (a === '-iname') { opts.name = args[++i]; opts.icase = true; }
      else if (a === '-type') { opts.type = args[++i]; }
      else if (a === '-maxdepth') { opts.maxdepth = Number(args[++i]); }
      else { io.stderr(`find: neznámá volba ${a}`); return 2; }
      i++;
    }

    // wildcard pattern → regex (glob: * ? [])
    let re = null;
    if (opts.name) {
      const escaped = opts.name.replace(/[.+^${}()|\\]/g, '\\$&')
        .replace(/\*/g, '.*').replace(/\?/g, '.');
      re = new RegExp('^' + escaped + '$', opts.icase ? 'i' : '');
    }

    function walk(path, depth) {
      const s = stat(path);
      if (!s) return;
      // pro start path vypisuj relativní jako uživatel zadal
      const matchName = !re || re.test(s.name);
      const matchType = !opts.type
        || (opts.type === 'f' && s.type === 'file')
        || (opts.type === 'd' && s.type === 'dir');
      if ((depth > 0 || (depth === 0 && (re || opts.type))) && matchName && matchType) {
        io.stdout(path || '.');
      } else if (depth === 0 && !re && !opts.type) {
        io.stdout(path || '.');
      }
      if (s.type === 'dir' && depth < opts.maxdepth) {
        const kids = readdir(path) || [];
        for (const k of kids) walk(k.path, depth + 1);
      }
    }
    for (const t of targets) {
      const p = t === '.' ? (session.cwd || '') : resolvePath(session.cwd, t);
      walk(p, 0);
    }
    return 0;
  },

  head(args, session, io) {
    let n = 10;
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-n') { n = Number(args[++i]) || 0; }
      else if (/^-\d+$/.test(a)) { n = Number(a.slice(1)); }
      else positional.push(a);
    }
    return readSlice(positional, n, 'head', session, io);
  },

  tail(args, session, io) {
    let n = 10;
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-n') { n = Number(args[++i]) || 0; }
      else if (/^-\d+$/.test(a)) { n = Number(a.slice(1)); }
      else positional.push(a);
    }
    return readSlice(positional, n, 'tail', session, io);
  },

  wc(args, session, io) {
    const flags = { l: false, w: false, c: false };
    const positional = [];
    for (const a of args) {
      if (a.startsWith('-')) {
        for (const ch of a.slice(1)) {
          if (ch in flags) flags[ch] = true;
        }
      } else positional.push(a);
    }
    const any = flags.l || flags.w || flags.c;
    const show = any ? flags : { l: true, w: true, c: true };

    function count(text) {
      const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      const chars = text.length;
      const parts = [];
      if (show.l) parts.push(String(lines));
      if (show.w) parts.push(String(words));
      if (show.c) parts.push(String(chars));
      return parts.join(' ');
    }

    if (!positional.length) {
      if (io.stdin == null) { io.stderr('wc: chybí soubor a žádný vstup'); return 1; }
      io.stdout(count(io.stdin));
      return 0;
    }
    let code = 0;
    for (const f of positional) {
      const p = resolvePath(session.cwd, f);
      const s = stat(p);
      if (!s) { io.stderr(`wc: ${f}: nic takového`); code = 1; continue; }
      if (s.type !== 'file') { io.stderr(`wc: ${f}: je adresář`); code = 1; continue; }
      // wc je sync — readFile by mělo být v paměti; pokud ne, řekni něco
      const node = s.node;
      const text = node.raw != null ? node.raw : (node.content != null ? node.content : null);
      if (text == null) { io.stderr(`wc: ${f}: obsah nenačten (zkuste \`cat ${f}\` nejdřív)`); code = 1; continue; }
      io.stdout(`${count(text)} ${f}`);
    }
    return code;
  },

  async mv(args, session, io) {
    const positional = args.filter((a) => !a.startsWith('-'));
    if (positional.length < 2) {
      io.stderr('mv: očekávám zdroj a cíl');
      return 1;
    }
    const dstArg = positional.pop();
    const dst = resolvePath(session.cwd, dstArg);
    let code = 0;
    for (const srcArg of positional) {
      const src = resolvePath(session.cwd, srcArg);
      const s = stat(src);
      if (!s) { io.stderr(`mv: ${srcArg}: neexistuje`); code = 1; continue; }
      let target = dst;
      if (exists(dst) && isDir(dst)) {
        const base = src.split('/').pop();
        target = dst ? `${dst}/${base}` : base;
      }
      try { await movePath(src, target); }
      catch (e) { io.stderr(`mv: ${srcArg}: ${e.message || e}`); code = 1; }
    }
    return code;
  },
};
