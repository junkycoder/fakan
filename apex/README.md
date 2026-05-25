# apex — `fakan.cz` (bez subdomény)

Tenký Cloudflare Worker, který rozhoduje, **co vidí návštěvník holé `fakan.cz`**.

## Princip

Transparent proxy. Worker sedí na route `fakan.cz/*`, přečte si env var
`ACTIVE_PROJECT` (např. `mindmap`, `projektX`) a všechen request přesměruje
(fetch, ne 301) na `<ACTIVE_PROJECT>.fakan.cz`. URL v prohlížeči zůstává
`fakan.cz/...`.

Přepnutí aktivního projektu:

```bash
cd apex
wrangler deploy --var ACTIVE_PROJECT=novy
```

Žádný build, žádné přesouvání souborů.

## TODO (WIP)

- [ ] `worker/index.js` — transparent fetch proxy s `ACTIVE_PROJECT` env varem
- [ ] `wrangler.jsonc` — route `fakan.cz/*`, žádné assets (worker-only)
- [ ] (volitelně) `public/` + fallback, kdyby ACTIVE_PROJECT byl prázdný → vlastní landing
