# WIP_NOTES — Restrukturalizace repa (větev `base`)

Pracovní log pro běžící refactor. Smazat po dokončení (nebo přesunout do FOK.md).

## Cíl

Repo má v rootu **jen složky** + `README.md` + `CLAUDE.md` + `AGENTS.md`
+ `LICENSE` + `Makefile` + dotfiles. Každá složka = subdoména = vlastní
Cloudflare Worker (raději Worker než Pages).

## Mapa subdomén (cílový stav)

| Složka     | Doména                | Účel                                                    |
| ---------- | --------------------- | ------------------------------------------------------- |
| `apex/`    | `fakan.cz`            | Transparent proxy → aktivní projekt (env `ACTIVE_PROJECT`) |
| `www/`     | `www.fakan.cz`        | Oficiální web pro veřejnost                             |
| `new/`     | `new.fakan.cz`        | Whitelabel wizard (klikni → build → nová subdoména)     |
| `mindmap/` | `mindmap.fakan.cz`    | Současný fakan char-grid player (přesun z rootu)        |
| `<další>/` | `<další>.fakan.cz`    | Vytvořené wizardem nebo ručně                           |

## Konvence

- Každá `<složka>/` má **vlastní `wrangler.jsonc`** — soběstačný deploy
- Layout uvnitř je per-projekt (žádná povinná `public/`) — wrangler určí co se servíruje
- Root `Makefile` umí `make deploy DIR=www` a `make deploy-all`
- **Žádný `shared/`** napoprvé — duplikace > premature deduplikace

## Checklist migrace

### Skeleton (hotovo)
- [x] `apex/README.md`, `www/README.md`, `new/README.md`
- [ ] Root `README.md` — přepsat na mapu subdomén
- [ ] Root `AGENTS.md` — vytvořit
- [ ] `CLAUDE.md` — anotovat probíhající migraci

### Migrace mindmap (TODO — bude se dělat na Macku)
- [ ] `git mv` všech `*.js`, `index.html`, `styles.css`, `vendor/` → `mindmap/`
- [ ] `git mv worker/ mindmap/worker/`
- [ ] `git mv agent/ mindmap/agent/` (per odpovědi user-a)
- [ ] `git mv mobile/ mindmap/mobile/`
- [ ] `git mv tests/ mindmap/tests/`
- [ ] `git mv promo/ mindmap/promo/`
- [ ] `git mv bin/ mindmap/bin/`
- [ ] `git mv Makefile mindmap/Makefile`
- [ ] `git mv wrangler.jsonc mindmap/wrangler.jsonc`
- [ ] `git mv .fokrc mindmap/.fokrc` (volitelně)

### Po přesunu (cesty)
- [ ] `mindmap/bin/build.sh` — `cd` ven o jeden level navíc už ne (přesun do mindmap/)
- [ ] `mindmap/wrangler.jsonc` — `main`/`assets` cesty (zůstanou relativní k mindmap/)
- [ ] `mindmap/mobile/capacitor.config.json` — `webDir: ../dist` (stejné, ../dist = mindmap/dist/)
- [ ] `mindmap/tests/playwright.config.js` — `webServer.cwd: '..'` (= mindmap/)
- [ ] `.claude/launch.json` — buď přesunout do `mindmap/.claude/launch.json`, nebo upravit cestu k `bin/serve.py`
- [ ] `.github/workflows/test.yml` — `working-directory: mindmap` nebo cesty
- [ ] `.gitignore` — `dist/` → `mindmap/dist/` (nebo nechat globálně)

### Root úroveň po migraci
- [ ] Nový `Makefile` v rootu — delegace `cd mindmap && $(MAKE) <target>`
  + `make deploy DIR=…` / `make deploy-all`
- [ ] `apex/wrangler.jsonc` + `apex/worker/index.js` — transparent proxy POC

### Apex worker
- [ ] `apex/worker/index.js`:
  ```js
  export default {
    async fetch(req, env) {
      const url = new URL(req.url);
      const target = `https://${env.ACTIVE_PROJECT}.fakan.cz${url.pathname}${url.search}`;
      return fetch(new Request(target, req));
    }
  };
  ```
- [ ] `apex/wrangler.jsonc` — `routes: [{ pattern: "fakan.cz/*", custom_domain: true }]`
- [ ] Otestovat: `wrangler deploy --var ACTIVE_PROJECT=mindmap` → `curl https://fakan.cz/` má vrátit obsah mindmap.fakan.cz

## Risky body / na co dát pozor

- **DNS / Workers Routes**: nový worker na `fakan.cz/*` přebije současný `fakan-cz` worker.
  Doporučení: před přepnutím apex workeru nejdřív deploynout `mindmap` worker pod
  `mindmap.fakan.cz` (nový custom domain), ověřit že funguje, **až pak** přesunout
  route na apex worker.
- **Mindmap mobile/Capacitor**: `webDir` zůstává `../dist`, ale `dist/` se generuje
  uvnitř `mindmap/` → `mindmap/mobile/` → `../dist` = `mindmap/dist/`. Sedí.
- **Tests CI**: `.github/workflows/test.yml` startuje server z rootu repa → po migraci
  buď upravit `working-directory: mindmap`, nebo `cd mindmap` v každém kroku.
- **`fakan-cz` worker name** v `wrangler.jsonc` zůstane (existující CF asset),
  jen se přejmenuje na `mindmap-fakan-cz` nebo `fakan-mindmap` (pozor, deploy si
  vytvoří nový worker, starý je třeba ručně mazat).

## Tested locally? Deployed?

Zatím **nic**. Skeleton commit + push, ostatní se dodělá na Macku.
