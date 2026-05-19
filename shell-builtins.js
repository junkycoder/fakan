// Built-in příkazy. Iterace 1: pwd, cd, ls, cat, echo, clear, help, exit.
// Write příkazy (mkdir, touch, rm, mv, cp) přijdou v iteraci 2.

import {
  resolvePath, stat, readdir, readFile, exists, isDir, normalizeCwd,
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
    io.stdout('Iterace 1: čtení FS (pwd, cd, ls, cat, echo).');
    io.stdout('Brzy: zápis (mkdir, touch, rm, mv, cp), pipes a .sh skripty.');
    return 0;
  },

  exit(args, session, io) {
    io.close();
    return 0;
  },
};
