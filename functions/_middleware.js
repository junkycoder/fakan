// SPA fallback pro Cloudflare Pages.
//
// Když user otevře `fakan.cz/projects/imagineanything.cz.html` v adresním
// řádku, default CF Pages servíruje ten soubor přímo (static-first), ne SPA
// shell. Tím se ztratí init z URL.
//
// Tento middleware to obrací: pokud klient chce HTML (browser page-load),
// vrátíme vždy `/index.html` (SPA shell), a frontend si z `location.pathname`
// otevře odpovídající panel.
//
// Pro fetch z aplikace (Accept: */*, application/json, atd.) middleware
// neintervenuje — static assety (tree.json, JS, CSS, raw soubory ze stromu)
// se servírují normálně.
//
// Specifické funkce (functions/waitlist.js → /waitlist) mají vyšší prioritu
// než `_middleware`, takže POST endpointy fungují nezávisle.

export const onRequest = async ({ request, next }) => {
  if (request.method !== 'GET') return next();
  const accept = request.headers.get('accept') || '';
  if (!accept.includes('text/html')) return next();

  const url = new URL(request.url);
  // root path nech projít rovnou
  if (url.pathname === '/' || url.pathname === '/index.html') return next();

  // všechno ostatní s Accept: text/html přepiš na index.html
  const rewritten = new Request(new URL('/index.html', url), request);
  return next(rewritten);
};
