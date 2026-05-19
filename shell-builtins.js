// Built-in příkazy. Iterace 1: pwd, cd, ls, cat, echo, clear, help, exit.
// Write příkazy (mkdir, touch, rm, mv, cp) přijdou v iteraci 2.

import {
  resolvePath, stat, readdir, readFile, exists, isDir, normalizeCwd,
  mkdir, mkdirP, touchFile, removePath, writeFile, copyFile, movePath,
} from './shell-fs.js';
import { SCRIPT_RUNNERS } from './shell.js';
import {
  ciGetToken, ciSetToken, ciGetEndpoint, ciSetEndpoint,
  ciHealth, ciVersion, ciStartRun,
} from './ci-client.js';

function fmtCwd(cwd) {
  const c = normalizeCwd(cwd);
  return c ? `~/${c}` : '~/';
}

// Otevři uzel ze zdroje v panelu přes host callback (openMain/openPreview/openAsFollower).
// Vrátí 0 pokud uzel existuje a otevřel se, jinak 1.
function openByPath(arg, session, io, openFn, kind) {
  const target = resolvePath(session.cwd, arg);
  const s = stat(target);
  if (!s) { io.stderr(`${kind}: ${arg}: nic takového`); return 1; }
  openFn(s.node);
  return 0;
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
    io.stdout('Proměnné: $VAR, ${VAR}, $? (poslední exit code)  ·  export VAR=val');
    io.stdout('Skripty:  bash script.sh  ·  ./script.sh  ·  source script.sh');
    io.stdout('Bloky:    for x in a b c; do …; done  ·  if cmd; then …; fi  ·  while');
    io.stdout('Globs:    *.md  ·  blog/*.html');
    io.stdout('Joby:     ve vimu Ctrl+Z = suspend  ·  fg = návrat  ·  jobs');
    io.stdout('Fakan:    open <p>  vim <p>  preview <p>  dock <z>  panels  recenter');
    io.stdout('CI:       ci run <p>  ·  ci run -c "<…>"  ·  ci token <s>  ·  ci health');
    io.stdout('Shell:    alias name=val  ·  unalias  ·  history  ·  export VAR=val');
    io.stdout('Rc:       ~/.fakanrc  — auto-source při startu terminálu');
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

  export(args, session, io) {
    if (!args.length) {
      const keys = Object.keys(session.env).sort();
      for (const k of keys) io.stdout(`export ${k}=${session.env[k]}`);
      return 0;
    }
    for (const a of args) {
      const eq = a.indexOf('=');
      if (eq < 0) {
        // export NAME bez hodnoty = jen označení (no-op u nás)
        continue;
      }
      const k = a.slice(0, eq);
      const v = a.slice(eq + 1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        io.stderr(`export: neplatné jméno: ${k}`);
        return 1;
      }
      session.env[k] = v;
    }
    return 0;
  },

  unset(args, session, io) {
    for (const a of args) {
      if (a in session.env) delete session.env[a];
    }
    return 0;
  },

  async bash(args, session, io) {
    if (!args.length) {
      io.stderr('bash: chybí skript');
      return 2;
    }
    // -c "...": exec inline
    if (args[0] === '-c') {
      if (args.length < 2) { io.stderr('bash: -c čeká argument'); return 2; }
      return await SCRIPT_RUNNERS.runScriptText(args[1], session, io);
    }
    const p = resolvePath(session.cwd, args[0]);
    return await SCRIPT_RUNNERS.runScriptFile(p, args.slice(1), session, io);
  },

  async sh(args, session, io) {
    return await BUILTINS.bash(args, session, io);
  },

  // source / . — totéž jako bash, ale konceptuálně "v aktuálním shellu". Naše
  // implementace bash už env zachovává mezi voláními, takže source = bash.
  async source(args, session, io) {
    return await BUILTINS.bash(args, session, io);
  },

  // fg — resume nejnovějšího suspendovaného editoru (bash job control analogie).
  // Po Ctrl+Z ve vimu se editor panel schoval; `fg` ho vrátí.
  fg(args, session, io) {
    const fn = session.host && session.host.resumeLastEditor;
    if (!fn) {
      io.stderr('fg: žádné suspendované úlohy');
      return 1;
    }
    const ok = fn();
    if (!ok) {
      io.stderr('fg: žádné suspendované úlohy');
      return 1;
    }
    return 0;
  },

  jobs(args, session, io) {
    const list = session.host && session.host.listJobs ? session.host.listJobs() : [];
    if (!list.length) {
      io.stdout('žádné suspendované úlohy');
      return 0;
    }
    list.forEach((job, i) => {
      io.stdout(`[${list.length - i}]+  Stopped  vim ${job}`);
    });
    return 0;
  },

  alias(args, session, io) {
    if (!args.length) {
      const keys = Object.keys(session.aliases).sort();
      if (!keys.length) return 0;
      for (const k of keys) io.stdout(`alias ${k}='${session.aliases[k]}'`);
      return 0;
    }
    let code = 0;
    for (const a of args) {
      const eq = a.indexOf('=');
      if (eq < 0) {
        if (a in session.aliases) io.stdout(`alias ${a}='${session.aliases[a]}'`);
        else { io.stderr(`alias: ${a}: nenalezen`); code = 1; }
        continue;
      }
      const k = a.slice(0, eq);
      let v = a.slice(eq + 1);
      // strip jediné páry uvozovek kolem hodnoty (bash compat)
      if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
        v = v.slice(1, -1);
      }
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k)) {
        io.stderr(`alias: neplatné jméno: ${k}`); code = 1; continue;
      }
      session.aliases[k] = v;
    }
    return code;
  },

  unalias(args, session, io) {
    for (const a of args) {
      if (a in session.aliases) delete session.aliases[a];
    }
    return 0;
  },

  history(args, session, io) {
    const n = args[0] ? Number(args[0]) : session.history.length;
    const slice = session.history.slice(-n);
    const offset = session.history.length - slice.length;
    slice.forEach((line, i) => {
      io.stdout(`${String(offset + i + 1).padStart(4)}  ${line}`);
    });
    return 0;
  },

  // --- fakan-specifické příkazy (most do panels.js přes session.host) -----

  open(args, session, io) {
    if (!args.length) { io.stderr('open: chybí cesta'); return 1; }
    const fn = session.host && session.host.openMain;
    if (!fn) { io.stderr('open: nedostupné v tomto kontextu'); return 1; }
    return openByPath(args[0], session, io, fn, 'main');
  },

  vim(args, session, io) {
    // vim <path> = open --mode source. Pokud path neexistuje, vytvoř ho.
    if (!args.length) { io.stderr('vim: chybí cesta'); return 1; }
    const fn = session.host && session.host.openMain;
    if (!fn) { io.stderr('vim: nedostupné v tomto kontextu'); return 1; }
    const target = resolvePath(session.cwd, args[0]);
    if (!exists(target)) {
      try { touchFile(target); }
      catch (e) { io.stderr(`vim: ${args[0]}: ${e.message || e}`); return 1; }
    }
    return openByPath(args[0], session, io, fn, 'source');
  },

  preview(args, session, io) {
    if (!args.length) { io.stderr('preview: chybí cesta'); return 1; }
    const fn = session.host && session.host.openPreview;
    if (!fn) { io.stderr('preview: nedostupné v tomto kontextu'); return 1; }
    return openByPath(args[0], session, io, fn, 'preview');
  },

  dock(args, session, io) {
    if (!args.length) { io.stderr('dock: čeká left|right|top|bottom|full'); return 1; }
    const zone = args[0];
    if (!['left', 'right', 'top', 'bottom', 'full'].includes(zone)) {
      io.stderr(`dock: neznámá zóna: ${zone}`); return 1;
    }
    const fn = session.host && session.host.dockPanel;
    if (!fn) { io.stderr('dock: nedostupné'); return 1; }
    fn(zone);
    return 0;
  },

  panels(args, session, io) {
    const fn = session.host && session.host.listPanels;
    if (!fn) { io.stderr('panels: nedostupné'); return 1; }
    const list = fn();
    if (!list.length) { io.stdout('žádné otevřené panely'); return 0; }
    for (const p of list) {
      io.stdout(`${p.variant.padEnd(8)} ${p.active ? '*' : ' '} ${p.path}`);
    }
    return 0;
  },

  recenter(args, session, io) {
    const fn = session.host && session.host.recenter;
    if (!fn) { io.stderr('recenter: nedostupné'); return 1; }
    const target = args[0] != null ? resolvePath(session.cwd, args[0]) : '';
    fn(target);
    return 0;
  },

  async ci(args, session, io) {
    const sub = args[0];
    if (!sub || sub === 'help') {
      io.stdout('ci run <script.sh>      spustí soubor v CI runneru');
      io.stdout('ci run -c "<inline>"    spustí inline skript');
      io.stdout('ci token <secret>       nastav bearer token (uloží do localStorage)');
      io.stdout('ci token --clear        smaž token');
      io.stdout('ci endpoint <url>       alternativní endpoint (default same origin)');
      io.stdout('ci endpoint --clear     reset endpointu na default');
      io.stdout('ci health               ověř /api/health');
      io.stdout('ci version              info o runneru');
      return 0;
    }

    if (sub === 'token') {
      if (args[1] == null) {
        io.stdout(ciGetToken() ? 'token nastaven (skryto)' : 'token NEnastaven');
        return 0;
      }
      if (args[1] === '--clear') { ciSetToken(''); io.stdout('token smazán'); return 0; }
      ciSetToken(args[1]);
      io.stdout('token uložen do localStorage');
      return 0;
    }

    if (sub === 'endpoint') {
      if (args[1] == null) { io.stdout(ciGetEndpoint() || '(default — current origin)'); return 0; }
      if (args[1] === '--clear') { ciSetEndpoint(''); io.stdout('endpoint reset na default'); return 0; }
      ciSetEndpoint(args[1]);
      io.stdout('endpoint uložen: ' + args[1]);
      return 0;
    }

    if (sub === 'health') {
      try { io.stdout('OK · ' + JSON.stringify(await ciHealth())); return 0; }
      catch (e) { io.stderr('ci health: ' + (e.message || e)); return 1; }
    }
    if (sub === 'version') {
      try { io.stdout(JSON.stringify(await ciVersion())); return 0; }
      catch (e) { io.stderr('ci version: ' + (e.message || e)); return 1; }
    }

    if (sub === 'run') {
      let script;
      if (args[1] === '-c') {
        script = args.slice(2).join(' ');
        if (!script) { io.stderr('ci run -c: chybí skript'); return 2; }
      } else {
        if (!args[1]) { io.stderr('ci run: čeká cestu k .sh nebo -c "<inline>"'); return 2; }
        const p = resolvePath(session.cwd, args[1]);
        const s = stat(p);
        if (!s) { io.stderr(`ci run: ${args[1]}: neexistuje`); return 1; }
        if (s.type !== 'file') { io.stderr(`ci run: ${args[1]}: není soubor`); return 1; }
        const text = await readFile(p);
        if (text == null) { io.stderr(`ci run: ${args[1]}: nelze přečíst`); return 1; }
        script = text;
      }
      let handle;
      try {
        handle = ciStartRun(script, {
          onMessage: (m) => {
            if (m.type === 'stdout') io.stdout(m.line);
            else if (m.type === 'stderr') io.stderr(m.line);
          },
          onError: (e) => io.stderr('CI WS error: ' + (e && e.message ? e.message : 'connection failed')),
        });
      } catch (e) {
        io.stderr('ci run: ' + (e.message || e));
        return 1;
      }
      const code = await handle.wait();
      return typeof code === 'number' ? code : 0;
    }

    io.stderr(`ci: neznámý subcommand "${sub}". Zkuste \`ci help\`.`);
    return 2;
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
