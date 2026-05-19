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
    if (longFmt) {
      for (const e of filtered) {
        const mark = e.type === 'dir' ? 'd' : '-';
        io.stdout(`${mark} ${e.name}${e.type === 'dir' ? '/' : ''}`);
      }
    } else {
      io.stdout(filtered
        .map((e) => e.type === 'dir' ? `${e.name}/` : e.name)
        .join('  '));
    }
    return 0;
  },

  async cat(args, session, io) {
    if (!args.length) {
      io.stderr('cat: chybí argument');
      return 1;
    }
    let code = 0;
    for (const arg of args) {
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
    io.stdout('Čtení: pwd, cd, ls (-a/-l), cat, echo.');
    io.stdout('Zápis: mkdir (-p), touch, rm (-r/-f), cp, mv.');
    io.stdout('Brzy: pipes, redirekce, .sh skripty, fakan příkazy (open, vim).');
    return 0;
  },

  exit(args, session, io) {
    io.close();
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
