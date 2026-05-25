// apex worker — transparent proxy pro holé fakan.cz.
//
// Princip: route fakan.cz/* sem mířuje, my podle env.ACTIVE_PROJECT
// fetchneme stejný path/query z https://<ACTIVE_PROJECT>.fakan.cz/...
// a vrátíme to. URL v browseru zůstává fakan.cz/...
//
// Přepnutí aktivního projektu:
//   wrangler deploy --var ACTIVE_PROJECT=<jmeno>
// nebo trvale ve wrangler.jsonc vars.
//
// Pokud ACTIVE_PROJECT chybí nebo je prázdné, vrátíme 503 (žádný projekt
// není aktivní). Případně si tady později můžeme přidat fallback na
// vlastní statiku v apex/public/.

export default {
  async fetch(request, env) {
    const active = (env.ACTIVE_PROJECT || '').trim();
    if (!active) {
      return new Response('fakan.cz: žádný aktivní projekt (ACTIVE_PROJECT je prázdné).', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, `https://${active}.fakan.cz`);

    // Forwarded request — zachováme metodu, headers i body, ale přepíšeme Host.
    const headers = new Headers(request.headers);
    headers.set('host', target.host);
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''));

    const upstream = await fetch(target.toString(), {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    });

    // Vrátíme upstream odpověď tak jak je. Cache-Control / cookies si řeší cílový
    // worker; tady se nepleteme.
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  },
};
