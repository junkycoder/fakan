// Handler pro `www.fakan.cz` — server-side rendered MD → HTML z GitHub repa
// `junkycoder/blendid`. Bejkárna: mindmapa zůstává na fakan.cz (bez www),
// na www-subdoméně se obyčejný blendid README/CHANGELOG ukáže jako web.
//
// Routing (jen GET):
//   /            → README.md
//   /changelog   → CHANGELOG.md
//   /license     → LICENSE (plain text wrapped in <pre>)
//   /raw/<file>  → raw markdown (debug)
//   ostatní      → 404 s odkazem zpět
//
// Markdown se cachuje v Cloudflare cache (default cache) na 5 minut, ať
// pro každý hit netáhneme GitHub. Branch a repo jdou přes vars / fallback.

import { renderMarkdown } from './markdown.js';

const REPO = 'junkycoder/blendid';
const BRANCH = 'master';
const CACHE_TTL = 300; // 5 min

const ROUTES = {
  '/': 'README.md',
  '/changelog': 'CHANGELOG.md',
  '/license': 'LICENSE',
};

export async function handleWww(request, env, ctx, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405 });
  }

  const path = url.pathname.replace(/\/+$/, '') || '/';

  // /raw/<file> — vrátit syrový markdown (pro debug / curl).
  const rawMatch = path.match(/^\/raw\/([\w.-]+)$/);
  if (rawMatch) {
    const file = rawMatch[1];
    const md = await fetchSource(file, ctx);
    if (!md) return notFound(url);
    return new Response(md, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': `public, max-age=${CACHE_TTL}`,
      },
    });
  }

  const file = ROUTES[path];
  if (!file) return notFound(url);

  const src = await fetchSource(file, ctx);
  if (src == null) return notFound(url);

  // LICENSE není markdown — obal do <pre>.
  let html, title;
  if (file === 'LICENSE') {
    html = `<pre class="plain">${escapeHtml(src)}</pre>`;
    title = 'Licence';
  } else {
    const r = renderMarkdown(src);
    html = r.html;
    title = r.meta.title || extractTitle(html) || prettyTitle(file);
  }

  return htmlResponse(renderPage({ title, body: html, path }));
}

async function fetchSource(file, ctx) {
  const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${file}`;
  // Edge cache hit?
  const cacheKey = new Request(`https://fakan-www-cache/${REPO}/${BRANCH}/${file}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached.text();

  const res = await fetch(url, {
    cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
  });
  if (!res.ok) return null;
  const text = await res.text();

  // Uložit do edge cache.
  const toCache = new Response(text, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': `public, max-age=${CACHE_TTL}`,
    },
  });
  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(cache.put(cacheKey, toCache));
  }
  return text;
}

function notFound(url) {
  return htmlResponse(renderPage({
    title: '404',
    body: `
      <h1>404</h1>
      <p>Tady nic není. Zkuste <a href="/">domů</a> nebo skočte na <a href="https://fakan.cz">mapu fakana</a>.</p>
    `,
    path: url.pathname,
  }), 404);
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=60',
      'x-content-type-options': 'nosniff',
    },
  });
}

function extractTitle(html) {
  const m = html.match(/<h1[^>]*>([\s\S]+?)<\/h1>/i);
  if (!m) return null;
  // Pokud je v H1 obrázek bez textu, použij jeho alt= (typicky logo s názvem).
  return m[1]
    .replace(/<img[^>]*\salt="([^"]+)"[^>]*>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function prettyTitle(file) {
  return file.replace(/\.md$/i, '').toLowerCase();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function renderPage({ title, body, path }) {
  const nav = renderNav(path);
  return `<!doctype html>
<html lang="cs">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${escapeHtml(title)} — blendid · www.fakan.cz</title>
  <meta name="description" content="Server-side rendered blendid docs běžící na www.fakan.cz. Mindmapa je vedle na fakan.cz.">
  <meta name="theme-color" content="#f6f3eb">
  <meta name="theme-color" content="#1a1814" media="(prefers-color-scheme: dark)">
  <style>${pageStyles()}</style>
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/">www.fakan.cz</a>
    <span class="sep">·</span>
    <span class="muted">server-rendered blendid</span>
    <span class="spacer"></span>
    <a class="ghost" href="https://fakan.cz">mapa →</a>
  </header>
  <nav class="tabs">${nav}</nav>
  <main class="prose">${body}</main>
  <footer class="footer">
    <span class="muted">zdroj: <a href="https://github.com/${REPO}">github.com/${REPO}</a> @ ${BRANCH}</span>
    <span class="spacer"></span>
    <a href="/raw/README.md" class="muted">raw</a>
  </footer>
</body>
</html>`;
}

function renderNav(currentPath) {
  const items = [
    { href: '/', label: 'readme' },
    { href: '/changelog', label: 'changelog' },
    { href: '/license', label: 'licence' },
  ];
  return items.map((it) => {
    const active = it.href === currentPath ? ' active' : '';
    return `<a class="tab${active}" href="${it.href}">${it.label}</a>`;
  }).join('');
}

function pageStyles() {
  // Inline CSS — žádný extra request, žádné FOUC. Sladěno s fakan paletou.
  return `
:root {
  --bg: #f6f3eb;
  --fg: #1a1814;
  --muted: #76726a;
  --line: #d9d3c4;
  --accent: #b14a3d;
  --accent2: #d9a83a;
  --code-bg: #ece6d4;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1a1814;
    --fg: #ece6d4;
    --muted: #8c877c;
    --line: #2e2a23;
    --accent: #e8745f;
    --accent2: #e8c45f;
    --code-bg: #24211b;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--fg);
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 15px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
::selection { background: var(--accent2); color: var(--fg); }

.topbar, .footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
}
.footer {
  border-bottom: 0;
  border-top: 1px solid var(--line);
  margin-top: 64px;
}
.brand { color: var(--fg); font-weight: 600; text-decoration: none; }
.brand:hover { color: var(--accent); }
.spacer { flex: 1; }
.muted { color: var(--muted); }
.ghost { color: var(--muted); text-decoration: none; }
.ghost:hover { color: var(--fg); }
.sep { color: var(--line); }

.tabs {
  display: flex;
  gap: 4px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--line);
  overflow-x: auto;
}
.tab {
  padding: 6px 12px;
  color: var(--muted);
  text-decoration: none;
  border-radius: 4px;
  white-space: nowrap;
}
.tab:hover { color: var(--fg); background: var(--code-bg); }
.tab.active { color: var(--fg); background: var(--code-bg); }

.prose {
  max-width: 760px;
  margin: 32px auto 0;
  padding: 0 24px;
}
.prose h1, .prose h2, .prose h3, .prose h4, .prose h5, .prose h6 {
  font-weight: 700;
  line-height: 1.25;
  margin: 1.6em 0 0.6em;
  scroll-margin-top: 16px;
}
.prose h1 { font-size: 28px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
.prose h2 { font-size: 22px; }
.prose h3 { font-size: 18px; }
.prose h4 { font-size: 16px; }
.prose p { margin: 1em 0; }
.prose a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.prose a:hover { color: var(--accent2); }
.prose ul, .prose ol { padding-left: 1.4em; margin: 1em 0; }
.prose li { margin: 0.25em 0; }
.prose blockquote {
  margin: 1em 0;
  padding: 0.2em 1em;
  border-left: 3px solid var(--accent2);
  color: var(--muted);
  background: var(--code-bg);
}
.prose hr { border: 0; border-top: 1px solid var(--line); margin: 2em 0; }
.prose code {
  background: var(--code-bg);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 0.92em;
}
.prose pre {
  background: var(--code-bg);
  padding: 14px 16px;
  border-radius: 6px;
  overflow-x: auto;
  margin: 1em 0;
  border: 1px solid var(--line);
}
.prose pre code { background: transparent; padding: 0; font-size: 0.88em; }
.prose pre.plain { white-space: pre-wrap; word-break: break-word; }
.prose img { max-width: 100%; height: auto; border-radius: 4px; }
.prose table { border-collapse: collapse; margin: 1em 0; width: 100%; font-size: 0.95em; }
.prose th, .prose td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; }
.prose th { background: var(--code-bg); }
.prose del { color: var(--muted); }

@media (max-width: 600px) {
  .topbar, .footer, .tabs { padding-left: 12px; padding-right: 12px; }
  .prose { padding: 0 16px; margin-top: 16px; }
  .prose h1 { font-size: 24px; }
}
  `.trim();
}
