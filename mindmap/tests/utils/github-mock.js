// Mock GitHub fixture pro Playwright. Zachytí api.github.com a raw.githubusercontent.com
// a vrátí deterministický mini-strom, aby testy neměly závislost na netu / rate limitu.
//
// Strom je navržen tak, aby ve všech 4 kvadrantech byl aspoň jeden text-soubor —
// to drží passing testy v rerooting / navigation / panels / vim-follower atd.

const DEFAULT_TREE = [
  // EAST (code) — src/, dotfile v rootu
  { path: 'src',                 type: 'tree' },
  { path: 'src/main.js',         type: 'blob' },
  { path: 'src/util.js',         type: 'blob' },
  { path: '.eslintrc',           type: 'blob' },

  // NORTH (texty/diary) — texty/, .md v rootu
  { path: 'texty',               type: 'tree' },
  { path: 'texty/uvod.md',       type: 'blob' },
  { path: 'texty/druhy.md',      type: 'blob' },
  { path: 'README.md',           type: 'blob' },

  // SOUTH (projects)
  { path: 'projects',            type: 'tree' },
  { path: 'projects/alfa.md',    type: 'blob' },
  { path: 'projects/beta.md',    type: 'blob' },

  // WEST (about/kontakt)
  { path: 'kontakt',             type: 'tree' },
  { path: 'kontakt/mail.md',     type: 'blob' },
  { path: 'about',               type: 'tree' },
  { path: 'about/me.md',         type: 'blob' },
];

const DEFAULT_FILES = {
  'src/main.js':       'console.log("hello mock");\n',
  'src/util.js':       'export const PI = 3.14;\n',
  '.eslintrc':         '{ "rules": {} }\n',
  'texty/uvod.md':     '# Úvod\n\nToto je úvodní text pro mock testy. Slovo *jablko* se hledá.\n',
  'texty/druhy.md':    '# Druhý text\n\nDalší obsah s **markdown** formátováním.\n',
  'README.md':         '# fakan mock repo\n\nDeterministický obsah pro e2e testy.\n',
  'projects/alfa.md':  '# Alfa projekt\n\nPopis prvního projektu.\n',
  'projects/beta.md':  '# Beta projekt\n\nPopis druhého projektu, obsahuje slovo jablko.\n',
  'kontakt/mail.md':   '# Mail\n\nhromada.dan@gmail.com\n',
  'about/me.md':       '# O mně\n\nBio.\n',
  '.fokrc':            '# žádné patterny\n',
  '.gitignore':        '# žádné ignory\n',
};

/**
 * Aplikuje mock na Playwright page. Voláno z bootApp(), ale i samostatně.
 * @param {import('@playwright/test').Page} page
 * @param {{ tree?: Array, files?: Record<string,string>, owner?: string, repo?: string, branch?: string }} [opts]
 */
export async function installGithubMock(page, opts = {}) {
  const owner = opts.owner || 'junkycoder';
  const repo = opts.repo || 'fakan.cz';
  const branch = opts.branch || 'main';
  const tree = opts.tree || DEFAULT_TREE;
  const files = { ...DEFAULT_FILES, ...(opts.files || {}) };

  // API: /repos/{owner}/{repo} — vrátí default_branch
  // API: /repos/{owner}/{repo}/git/trees/{branch}?recursive=1 — strom
  // API: /repos/{owner}/{repo}/contents/{path}?ref={branch} (s tokenem) — raw text
  // RAW: raw.githubusercontent.com/{owner}/{repo}/{branch}/{path} — text
  await page.route(/api\.github\.com|raw\.githubusercontent\.com/, async (route) => {
    const url = new URL(route.request().url());
    const host = url.hostname;
    const pathname = decodeURIComponent(url.pathname);

    if (host === 'api.github.com') {
      // /repos/{owner}/{repo}
      const repoMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)$/);
      if (repoMatch) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ name: repo, default_branch: branch, owner: { login: owner } }),
        });
      }

      // /repos/{owner}/{repo}/git/trees/{branch}
      const treesMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([^/]+)$/);
      if (treesMatch) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            sha: 'mock-sha',
            tree: tree.map((e) => ({ ...e, mode: e.type === 'tree' ? '040000' : '100644', sha: 'mock' })),
            truncated: false,
          }),
        });
      }

      // /repos/{owner}/{repo}/contents/{path}
      const contentsMatch = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
      if (contentsMatch) {
        const filePath = contentsMatch[3];
        const body = files[filePath];
        if (body == null) return route.fulfill({ status: 404, body: 'not found' });
        return route.fulfill({ status: 200, contentType: 'text/plain', body });
      }

      // /repos/{owner}/{repo}/branches — pro branch picker
      if (/^\/repos\/[^/]+\/[^/]+\/branches/.test(pathname)) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([{ name: branch }]),
        });
      }

      // /repos/{owner}/{repo}/commits — pro `git log`
      if (/^\/repos\/[^/]+\/[^/]+\/commits/.test(pathname)) {
        const fakeCommits = [
          {
            sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            commit: { message: 'mock: initial commit', author: { name: 'Mock', date: '2026-01-01T10:00:00Z' } },
            author: { login: 'mockuser' },
          },
          {
            sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            commit: { message: 'mock: druhý commit', author: { name: 'Mock', date: '2026-01-02T10:00:00Z' } },
            author: { login: 'mockuser' },
          },
        ];
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(fakeCommits),
        });
      }

      // /user, /user/repos — pro GitHub dialog (občas se ptá)
      if (pathname === '/user' || pathname.startsWith('/user/repos')) {
        return route.fulfill({ status: 401, body: 'no auth' });
      }

      // ostatní /api.github.com cesty — vrať 404 tiše
      return route.fulfill({ status: 404, body: 'mock: unhandled api path' });
    }

    if (host === 'raw.githubusercontent.com') {
      // /{owner}/{repo}/{branch}/{path}
      const m = pathname.match(/^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
      if (m) {
        const filePath = m[4];
        const body = files[filePath];
        if (body == null) return route.fulfill({ status: 404, body: 'not found' });
        return route.fulfill({ status: 200, contentType: 'text/plain', body });
      }
      return route.fulfill({ status: 404, body: 'mock: unhandled raw path' });
    }

    return route.continue();
  });
}

export { DEFAULT_TREE, DEFAULT_FILES };
