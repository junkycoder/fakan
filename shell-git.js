// Git subcommands pro terminál. Napojí se na GitHub zdroj (state.githubSpec)
// a přes existující helpery v sources.js dělá status / log / commit / push /
// pull / fetch / branch / checkout.
//
// Lokální repo neexistuje — všechny operace běží proti remote (GitHub API).
// `commit` a `push` jsou proto v podstatě jedna akce; `pull` = re-fetch tree;
// `fetch` = jen kontrola remote stavu bez přemountování.

import { state } from './state.js';
import {
  ghApi, ghListBranches, ghPush, collectGithubPushFiles, connectGithub,
  refreshPublishVisibility,
} from './sources.js';

function requireSpec(io) {
  const spec = state.githubSpec;
  if (!spec) {
    io.stderr('git: žádný GitHub zdroj. Připojte repo přes „Zdroj" ▾ → „Připojit GitHub".');
    return null;
  }
  return spec;
}

function requireToken(spec, io, op) {
  if (!spec.token) {
    io.stderr(`git ${op}: chybí token (read-only mode). Přidejte token přes „Zdroj" ▾ → „Připojit GitHub".`);
    return false;
  }
  return true;
}

function shortSha(s) { return s ? String(s).slice(0, 7) : ''; }

function fmtRelTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso || '';
  const diff = Math.max(0, Date.now() - t);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `před ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `před ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `před ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `před ${d} dny`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `před ${mo} měs.`;
  return `před ${Math.floor(mo / 12)} lety`;
}

// Parse arg pattern: -m "msg" / -m=msg / --message msg
function getOpt(args, names) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    for (const n of names) {
      if (a === n) return { value: args[i + 1] ?? '', rest: args.filter((_, idx) => idx !== i && idx !== i + 1) };
      if (a.startsWith(n + '=')) return { value: a.slice(n.length + 1), rest: args.filter((_, idx) => idx !== i) };
    }
  }
  return { value: null, rest: args };
}

async function gitStatus(args, session, io) {
  const spec = requireSpec(io);
  if (!spec) return 1;
  io.stdout(`Na větvi ${spec.branch || 'main'}`);
  io.stdout(`Remote: ${spec.owner}/${spec.repo}`);
  if (!state.originalTree) { io.stdout('(strom nenačten)'); return 0; }
  let files;
  try { files = await collectGithubPushFiles(state.originalTree); }
  catch (e) { io.stderr('git status: ' + (e.message || e)); return 1; }
  if (!files.length) { io.stdout(''); io.stdout('Žádné změny — pracovní strom čistý.'); return 0; }
  io.stdout('');
  io.stdout(`Změny k commitu (${files.length}):`);
  for (const f of files) {
    const sign = f.kind === 'add' ? 'A' : f.kind === 'del' ? 'D' : 'M';
    io.stdout(`  ${sign}  ${f.path}`);
  }
  return 0;
}

async function gitLog(args, session, io) {
  const spec = requireSpec(io);
  if (!spec) return 1;
  let n = 10;
  const { value, rest } = getOpt(args, ['-n', '--max-count']);
  if (value != null) n = Math.max(1, Math.min(100, Number(value) || 10));
  // -<N> shortcut (`git log -5`)
  for (const a of rest) {
    const m = a.match(/^-(\d+)$/);
    if (m) n = Math.max(1, Math.min(100, Number(m[1])));
  }
  const branch = spec.branch || 'main';
  try {
    const commits = await ghApi(spec, `/repos/${spec.owner}/${spec.repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${n}`);
    if (!Array.isArray(commits) || !commits.length) { io.stdout('(žádné commity)'); return 0; }
    for (const c of commits) {
      const sha = shortSha(c.sha);
      const author = c.commit?.author?.name || c.author?.login || '?';
      const when = fmtRelTime(c.commit?.author?.date);
      const msg = (c.commit?.message || '').split('\n')[0];
      io.stdout(`${sha}  ${msg}`);
      io.stdout(`        ${author} · ${when}`);
    }
    return 0;
  } catch (e) {
    io.stderr('git log: ' + (e.message || e));
    return 1;
  }
}

async function gitCommit(args, session, io) {
  const spec = requireSpec(io);
  if (!spec) return 1;
  if (!requireToken(spec, io, 'commit')) return 1;
  const { value: msg } = getOpt(args, ['-m', '--message']);
  if (!msg) { io.stderr('git commit: chybí zpráva. Použijte -m "zpráva".'); return 2; }
  if (!state.originalTree) { io.stderr('git commit: strom nenačten'); return 1; }
  let files;
  try { files = await collectGithubPushFiles(state.originalTree); }
  catch (e) { io.stderr('git commit: ' + (e.message || e)); return 1; }
  if (!files.length) { io.stdout('Pracovní strom je čistý — nic k commitu.'); return 0; }
  io.stdout(`Commituji ${files.length} ${files.length === 1 ? 'změnu' : 'změn'} do ${spec.owner}/${spec.repo}@${spec.branch || 'main'}…`);
  try {
    const res = await ghPush(spec, msg, files, (m) => io.stdout(`  ${m}`));
    if (res.unchanged) { io.stdout('Nic se nezměnilo (tree match).'); return 0; }
    io.stdout(`Hotovo — commit ${shortSha(res.sha)} na ${spec.branch || 'main'}.`);
    refreshPublishVisibility();
    return 0;
  } catch (e) {
    io.stderr('git commit: ' + (e.message || e));
    return 1;
  }
}

async function gitPush(args, session, io) {
  const spec = requireSpec(io);
  if (!spec) return 1;
  // V našem modelu commit = push (žádný local repo). Pokud user napíše
  // `git push` bez `git commit -m`, ukaž status a navedeme ho.
  let files;
  try { files = await collectGithubPushFiles(state.originalTree); }
  catch (e) { io.stderr('git push: ' + (e.message || e)); return 1; }
  if (!files.length) {
    io.stdout(`Vše na ${spec.branch || 'main'} je up-to-date.`);
    return 0;
  }
  io.stdout(`${files.length} ${files.length === 1 ? 'změna' : 'změn'} čeká — použijte:`);
  io.stdout(`  git commit -m "zpráva"`);
  return 0;
}

async function gitPull(args, session, io) {
  const spec = requireSpec(io);
  if (!spec) return 1;
  // pokud jsou lokální změny, varuj — pull je přepíše
  let files = [];
  try { files = await collectGithubPushFiles(state.originalTree); } catch {}
  if (files.length && !args.includes('-f') && !args.includes('--force')) {
    io.stderr(`git pull: máte ${files.length} necommitovaných změn. Použijte -f pro přepsání, nebo nejdřív \`git commit\`.`);
    return 1;
  }
  io.stdout(`Pulluji ${spec.owner}/${spec.repo}@${spec.branch || 'main'}…`);
  try {
    await connectGithub({ ...spec }, (m) => io.stdout(`  ${m}`));
    io.stdout('Aktualizováno.');
    return 0;
  } catch (e) {
    io.stderr('git pull: ' + (e.message || e));
    return 1;
  }
}

async function gitFetch(args, session, io) {
  const spec = requireSpec(io);
  if (!spec) return 1;
  try {
    io.stdout(`Fetchuji ${spec.owner}/${spec.repo}…`);
    const branches = await ghListBranches(spec);
    const head = await ghApi(spec, `/repos/${spec.owner}/${spec.repo}/git/refs/heads/${encodeURIComponent(spec.branch || 'main')}`);
    io.stdout(`Větví na remote: ${branches.length}`);
    io.stdout(`HEAD ${spec.branch || 'main'}: ${shortSha(head?.object?.sha)}`);
    io.stdout('(fetch jen načte remote stav; změny se neaplikují, použijte `git pull`)');
    return 0;
  } catch (e) {
    io.stderr('git fetch: ' + (e.message || e));
    return 1;
  }
}

async function gitBranch(args, session, io) {
  const spec = requireSpec(io);
  if (!spec) return 1;

  // delete: -d <name> nebo -D <name>
  const delIdx = args.findIndex((a) => a === '-d' || a === '-D' || a === '--delete');
  if (delIdx >= 0) {
    const name = args[delIdx + 1];
    if (!name) { io.stderr('git branch -d: chybí jméno větve'); return 2; }
    if (!requireToken(spec, io, 'branch -d')) return 1;
    if (name === (spec.branch || 'main')) {
      io.stderr(`git branch -d: nelze smazat aktivní větev "${name}". Přepněte se nejdřív přes \`git checkout\`.`);
      return 1;
    }
    try {
      await ghApi(spec, `/repos/${spec.owner}/${spec.repo}/git/refs/heads/${encodeURIComponent(name)}`, { method: 'DELETE' });
      io.stdout(`Smazána větev "${name}".`);
      return 0;
    } catch (e) {
      io.stderr('git branch -d: ' + (e.message || e));
      return 1;
    }
  }

  // create: git branch <name> [from]
  const positional = args.filter((a) => !a.startsWith('-'));
  if (positional.length) {
    const name = positional[0];
    const from = positional[1] || spec.branch || 'main';
    if (!requireToken(spec, io, 'branch')) return 1;
    try {
      const head = await ghApi(spec, `/repos/${spec.owner}/${spec.repo}/git/refs/heads/${encodeURIComponent(from)}`);
      const sha = head?.object?.sha;
      if (!sha) { io.stderr(`git branch: nepodařilo se najít HEAD pro "${from}"`); return 1; }
      await ghApi(spec, `/repos/${spec.owner}/${spec.repo}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${name}`, sha }),
      });
      io.stdout(`Vytvořena větev "${name}" z ${shortSha(sha)} (${from}).`);
      io.stdout(`Pro přepnutí: \`git checkout ${name}\``);
      return 0;
    } catch (e) {
      io.stderr('git branch: ' + (e.message || e));
      return 1;
    }
  }

  // list
  try {
    const branches = await ghListBranches(spec);
    if (!branches.length) { io.stdout('(žádné větve)'); return 0; }
    const cur = spec.branch || 'main';
    for (const b of branches.sort()) {
      io.stdout(`${b === cur ? '*' : ' '} ${b}`);
    }
    return 0;
  } catch (e) {
    io.stderr('git branch: ' + (e.message || e));
    return 1;
  }
}

async function gitCheckout(args, session, io) {
  const spec = requireSpec(io);
  if (!spec) return 1;
  // -b <name>: vytvoř + přepni
  const bIdx = args.indexOf('-b');
  let name;
  let createFirst = false;
  if (bIdx >= 0) {
    name = args[bIdx + 1];
    createFirst = true;
  } else {
    name = args.find((a) => !a.startsWith('-'));
  }
  if (!name) { io.stderr('git checkout: čeká jméno větve'); return 2; }
  if (name === (spec.branch || 'main') && !createFirst) {
    io.stdout(`Už jste na větvi "${name}".`); return 0;
  }

  // varuj na lokální změny
  let files = [];
  try { files = await collectGithubPushFiles(state.originalTree); } catch {}
  if (files.length && !args.includes('-f') && !args.includes('--force')) {
    io.stderr(`git checkout: máte ${files.length} necommitovaných změn. Použijte -f pro přepsání, nebo nejdřív \`git commit\`.`);
    return 1;
  }

  if (createFirst) {
    if (!requireToken(spec, io, 'checkout -b')) return 1;
    try {
      const head = await ghApi(spec, `/repos/${spec.owner}/${spec.repo}/git/refs/heads/${encodeURIComponent(spec.branch || 'main')}`);
      const sha = head?.object?.sha;
      await ghApi(spec, `/repos/${spec.owner}/${spec.repo}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${name}`, sha }),
      });
      io.stdout(`Vytvořena větev "${name}" z ${shortSha(sha)}.`);
    } catch (e) {
      io.stderr('git checkout -b: ' + (e.message || e));
      return 1;
    }
  }

  io.stdout(`Přepínám na větev "${name}"…`);
  try {
    await connectGithub({ ...spec, branch: name }, (m) => io.stdout(`  ${m}`));
    io.stdout(`Přepnuto na "${name}".`);
    return 0;
  } catch (e) {
    io.stderr('git checkout: ' + (e.message || e));
    return 1;
  }
}

function gitHelp(io) {
  io.stdout('Příkazy git (proti remote přes GitHub API — žádný lokální repo):');
  io.stdout('  git status                 změny vůči remote');
  io.stdout('  git log [-n N]             posledních N commitů (default 10)');
  io.stdout('  git commit -m "zpráva"     publikuje všechny změny na remote');
  io.stdout('  git push                   alias: ukáže, co commit by udělal');
  io.stdout('  git pull [-f]              znovu načte aktuální větev');
  io.stdout('  git fetch                  ověří remote (větve, HEAD)');
  io.stdout('  git branch                 seznam větví');
  io.stdout('  git branch <name> [from]   vytvořit větev (default z aktuální)');
  io.stdout('  git branch -d <name>       smazat větev');
  io.stdout('  git checkout <name>        přepnout na větev');
  io.stdout('  git checkout -b <name>     vytvořit + přepnout');
  io.stdout('');
  io.stdout('Pro zápis (commit/branch/checkout -b) je nutný token s repo scope.');
}

export async function gitCmd(args, session, io) {
  const sub = args[0];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') { gitHelp(io); return 0; }
  const rest = args.slice(1);
  switch (sub) {
    case 'status':   return gitStatus(rest, session, io);
    case 'log':      return gitLog(rest, session, io);
    case 'commit':   return gitCommit(rest, session, io);
    case 'push':     return gitPush(rest, session, io);
    case 'pull':     return gitPull(rest, session, io);
    case 'fetch':    return gitFetch(rest, session, io);
    case 'branch':   return gitBranch(rest, session, io);
    case 'checkout': return gitCheckout(rest, session, io);
    default:
      io.stderr(`git: neznámý subcommand "${sub}". Zkuste \`git help\`.`);
      return 2;
  }
}
