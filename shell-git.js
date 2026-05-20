// Git subcommands pro terminál. Napojí se na GitHub zdroj (state.githubSpec)
// a přes existující helpery v sources.js dělá status / log / commit / push /
// pull / fetch / branch / checkout.
//
// Lokální repo neexistuje — všechny operace běží proti remote (GitHub API).
// `commit` a `push` jsou proto v podstatě jedna akce; `pull` = re-fetch tree;
// `fetch` = jen kontrola remote stavu bez přemountování.

import { state, LS_EDIT_PREFIX, splitExt, isTextFile } from './state.js';
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

// Najdi text souboru po cestě v originalTree (raw + override). Vrací
// { node, originalText, currentText } nebo null pokud cesta nesedí.
function findNodeByPath(tree, path) {
  if (!tree || !path) return null;
  const parts = path.split('/');
  let cur = tree;
  for (let i = 0; i < parts.length; i++) {
    if (!cur || !Array.isArray(cur.children)) return null;
    const seg = parts[i];
    const isLast = i === parts.length - 1;
    cur = cur.children.find((c) => isLast
      ? (c.type === 'file' && (c.filename || c.name) === seg)
      : (c.type === 'dir' && c.name === seg));
    if (!cur) return null;
  }
  return cur;
}

function loadEditOverrideRaw(path) {
  try { return localStorage.getItem(LS_EDIT_PREFIX + path); } catch { return null; }
}

// Klasický LCS-based unified diff. Pro rozumné soubory (do ~5k řádků).
function diffLines(oldText, newText) {
  const a = (oldText || '').split('\n');
  const b = (newText || '').split('\n');
  const m = a.length, n = b.length;
  const LIMIT = 5000;
  if (m > LIMIT || n > LIMIT) {
    return [{ type: 'note', text: `(soubor je příliš velký pro line-diff — ${m} vs ${n} řádků)` }];
  }
  const dp = [];
  for (let i = 0; i <= m; i++) dp.push(new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { ops.push({ type: 'eq', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'del', text: a[i] }); i++; }
    else { ops.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < m) ops.push({ type: 'del', text: a[i++] });
  while (j < n) ops.push({ type: 'add', text: b[j++] });
  return ops;
}

// Z LCS ops vyrobí unified diff hunks s 3 řádky kontextu kolem změn.
function formatHunks(ops, contextLines = 3) {
  if (ops.length === 1 && ops[0].type === 'note') return [ops[0].text];
  const lines = [];
  let aLine = 1, bLine = 1;
  // Najdi indexy s diff op
  const diffIdx = ops.map((o, idx) => (o.type !== 'eq' ? idx : -1)).filter((i) => i >= 0);
  if (!diffIdx.length) return [];
  // Slož sousedící hunky podle vzdálenosti < 2 * contextLines
  const groups = [];
  let cur = null;
  for (const idx of diffIdx) {
    if (!cur) { cur = { from: idx, to: idx }; continue; }
    if (idx - cur.to <= 2 * contextLines) cur.to = idx;
    else { groups.push(cur); cur = { from: idx, to: idx }; }
  }
  if (cur) groups.push(cur);

  // Spočti aLine/bLine před začátkem skupiny
  function lineCounts(upToIdx) {
    let aL = 1, bL = 1;
    for (let k = 0; k < upToIdx; k++) {
      if (ops[k].type === 'eq') { aL++; bL++; }
      else if (ops[k].type === 'del') aL++;
      else if (ops[k].type === 'add') bL++;
    }
    return [aL, bL];
  }

  for (const g of groups) {
    const start = Math.max(0, g.from - contextLines);
    const end = Math.min(ops.length - 1, g.to + contextLines);
    let [aStart, bStart] = lineCounts(start);
    let aCount = 0, bCount = 0;
    for (let k = start; k <= end; k++) {
      if (ops[k].type === 'eq') { aCount++; bCount++; }
      else if (ops[k].type === 'del') aCount++;
      else if (ops[k].type === 'add') bCount++;
    }
    lines.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (let k = start; k <= end; k++) {
      const o = ops[k];
      lines.push((o.type === 'eq' ? ' ' : o.type === 'del' ? '-' : '+') + o.text);
    }
  }
  return lines;
}

function diffStat(ops) {
  let add = 0, del = 0;
  for (const o of ops) {
    if (o.type === 'add') add++;
    else if (o.type === 'del') del++;
  }
  return { add, del };
}

async function gitDiff(args, session, io) {
  const spec = requireSpec(io);
  if (!spec) return 1;
  if (!state.originalTree) { io.stderr('git diff: strom nenačten'); return 1; }

  const statOnly = args.includes('--stat');
  const positional = args.filter((a) => !a.startsWith('-'));
  const targetPath = positional[0] || null;

  let files;
  try { files = await collectGithubPushFiles(state.originalTree); }
  catch (e) { io.stderr('git diff: ' + (e.message || e)); return 1; }

  const filtered = targetPath ? files.filter((f) => f.path === targetPath) : files;
  if (targetPath && !filtered.length) {
    // existuje vůbec? rozliš „beze změny" vs „neexistuje"
    const node = findNodeByPath(state.originalTree, targetPath);
    if (!node && !state.ghBaselinePaths.has(targetPath)) {
      io.stderr(`git diff: ${targetPath}: cesta neexistuje`);
      return 1;
    }
    return 0; // bez změn
  }
  if (!filtered.length) return 0;

  const dec = new TextDecoder();

  // Pro --stat shrnutí
  if (statOnly) {
    let totalAdd = 0, totalDel = 0;
    const rows = [];
    for (const f of filtered) {
      let oldText = '', newText = '';
      if (f.kind === 'del') {
        try { oldText = await fetchBaselineText(spec, f.path); }
        catch { rows.push({ path: f.path, label: 'D  (binary / nelze stáhnout)' }); continue; }
        newText = '';
      } else if (f.kind === 'add') {
        oldText = '';
        newText = dec.decode(f.data);
      } else {
        const node = findNodeByPath(state.originalTree, f.path);
        oldText = node && node._originalRaw != null ? node._originalRaw : (node && node.raw != null ? node.raw : '');
        newText = dec.decode(f.data);
      }
      const ops = diffLines(oldText, newText);
      const { add, del } = diffStat(ops);
      totalAdd += add; totalDel += del;
      rows.push({ path: f.path, kind: f.kind, add, del });
    }
    const maxPath = Math.max(...rows.map((r) => r.path.length));
    for (const r of rows) {
      if (r.label) { io.stdout(` ${r.path.padEnd(maxPath)} | ${r.label}`); continue; }
      const sign = r.kind === 'add' ? 'A' : r.kind === 'del' ? 'D' : 'M';
      io.stdout(` ${r.path.padEnd(maxPath)} | ${sign}  +${r.add} -${r.del}`);
    }
    io.stdout(` ${filtered.length} ${filtered.length === 1 ? 'soubor změněn' : 'souborů změněno'}, +${totalAdd}/-${totalDel}`);
    return 0;
  }

  for (let idx = 0; idx < filtered.length; idx++) {
    const f = filtered[idx];
    if (idx > 0) io.stdout('');
    io.stdout(`diff --git a/${f.path} b/${f.path}`);
    if (f.kind === 'add') {
      io.stdout('new file mode 100644');
      io.stdout(`--- /dev/null`);
      io.stdout(`+++ b/${f.path}`);
      const newText = dec.decode(f.data);
      const ops = diffLines('', newText);
      for (const ln of formatHunks(ops)) io.stdout(ln);
    } else if (f.kind === 'del') {
      io.stdout('deleted file mode 100644');
      io.stdout(`--- a/${f.path}`);
      io.stdout(`+++ /dev/null`);
      let oldText;
      try { oldText = await fetchBaselineText(spec, f.path); }
      catch (e) { io.stdout(`(nelze stáhnout baseline: ${e.message || e})`); continue; }
      const ops = diffLines(oldText, '');
      for (const ln of formatHunks(ops)) io.stdout(ln);
    } else {
      io.stdout(`--- a/${f.path}`);
      io.stdout(`+++ b/${f.path}`);
      const node = findNodeByPath(state.originalTree, f.path);
      const oldText = node && node._originalRaw != null ? node._originalRaw
        : (node && node.raw != null ? node.raw : '');
      const overrideText = loadEditOverrideRaw(f.path);
      const newText = overrideText != null ? overrideText : (node?.raw ?? '');
      const ops = diffLines(oldText, newText);
      for (const ln of formatHunks(ops)) io.stdout(ln);
    }
  }
  return 0;
}

async function fetchBaselineText(spec, path) {
  const segs = path.split('/').map(encodeURIComponent).join('/');
  if (spec.token) {
    const r = await fetch(`https://api.github.com/repos/${spec.owner}/${spec.repo}/contents/${segs}?ref=${encodeURIComponent(spec.branch || 'main')}`, {
      headers: { Accept: 'application/vnd.github.raw', Authorization: `Bearer ${spec.token}` },
    });
    if (!r.ok) throw new Error(`baseline ${r.status}`);
    return r.text();
  }
  const r = await fetch(`https://raw.githubusercontent.com/${spec.owner}/${spec.repo}/${encodeURIComponent(spec.branch || 'main')}/${segs}`);
  if (!r.ok) throw new Error(`raw ${r.status}`);
  return r.text();
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
  io.stdout('  git diff [path] [--stat]   unified diff (nebo souhrn +/- per soubor)');
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
    case 'diff':     return gitDiff(rest, session, io);
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
