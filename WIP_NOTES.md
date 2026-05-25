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

### Skeleton + docs (hotovo)
- [x] `apex/README.md`, `www/README.md`, `new/README.md`
- [x] Root `README.md` — přepsáno na mapu subdomén
- [x] Root `AGENTS.md` — vytvořeno
- [x] `CLAUDE.md` — anotováno warningem o probíhající migraci

### Migrace mindmap (hotovo — všechen kód v mindmap/)
- [x] `git mv` všech `*.js`, `index.html`, `styles.css`, `vendor/` → `mindmap/`
- [x] `git mv worker/ mindmap/worker/`
- [x] `git mv agent/ mindmap/agent/` (per odpovědi user-a)
- [x] `git mv mobile/ mindmap/mobile/`
- [x] `git mv tests/ mindmap/tests/`
- [x] `git mv promo/ mindmap/promo/`
- [x] `git mv bin/ mindmap/bin/`
- [x] `git mv Makefile mindmap/Makefile`
- [x] `git mv wrangler.jsonc mindmap/wrangler.jsonc`
- [ ] `.fokrc` v rootu — zatím necháno, není používán z mindmap kódu;
      user může smazat nebo přesunout dle uvážení

### Cesty po přesunu (hotovo)
- [x] `.github/workflows/test.yml` — `working-directory: mindmap/tests`
      + `cache-dependency-path: mindmap/tests/package-lock.json`
      + `path: mindmap/tests/playwright-report`
- [x] `.claude/launch.json` — `cd mindmap && python3 bin/serve.py $PORT`
- [x] `.gitignore` — `tests/*` patterns → `mindmap/tests/*`
- [x] `mindmap/bin/build.sh` — žádná úprava potřeba (relativní cesty fungují)
- [x] `mindmap/wrangler.jsonc` — žádná úprava potřeba
- [x] `mindmap/mobile/capacitor.config.json` — `../dist` stále sedí (mindmap/dist/)
- [x] `mindmap/tests/playwright.config.js` — `cwd: '..'` stále sedí (= mindmap/)

### Root úroveň (hotovo)
- [x] Nový root `Makefile` — `make deploy DIR=mindmap`, `make deploy-all`, `make list`
- [x] `apex/wrangler.jsonc` + `apex/worker/index.js` — transparent proxy POC

## Co dodělat na Macku

### 1. Lokální ověření po pull
```bash
git fetch origin claude/repo-structure-design-faZii
git checkout -b base origin/claude/repo-structure-design-faZii
cd mindmap
make dev                  # python3 bin/serve.py 5173 → otevři http://localhost:5173
make test                 # Playwright e2e
make build                # ověř že dist/ se vytvoří správně
```

### 2. Worker rename / route plan (před deployem)
Současný `mindmap/wrangler.jsonc` má `name: fakan-cz`. To je název existujícího
Worker assetu v CF. Po `wrangler deploy` z `mindmap/` se _přepíše_ stejný
worker (good — žádné výpadky). Ale jméno `fakan-cz` je matoucí pro mindmap-only:

**Návrh přejmenování:**
1. V `mindmap/wrangler.jsonc` změnit `name: fakan-cz` → `name: fakan-mindmap`
2. V CF dashboardu přidat custom domain `mindmap.fakan.cz` na nový worker
3. Deploy `mindmap/`: `cd mindmap && wrangler deploy`
4. V CF: odstranit route `fakan.cz/*` ze starého `fakan-cz` workeru, smazat ho
5. Deploy apexu: `cd apex && wrangler deploy`
6. V CF: přidat route `fakan.cz/*` na nový `fakan-apex` worker

Tím získáme: `mindmap.fakan.cz` (přímý), `fakan.cz/*` (proxy z apex → mindmap).
Žádný downtime, dokud krok 4 a 6 nepřijdou na řadu.

### 3. Otestovat apex proxy
```bash
cd apex
wrangler dev        # lokálně na 8787
curl -H 'Host: fakan.cz' http://localhost:8787/   # má vrátit mindmap.fakan.cz HTML
```

### 4. Smazat tento WIP_NOTES.md
Po dokončení (a otestování že vše funguje) smaž `WIP_NOTES.md` a smaž warning
v `CLAUDE.md`. Aktualizuj `CLAUDE.md` paths (`worker/index.js` → `mindmap/worker/index.js` atd.).

## Risky body / na co dát pozor

- **DNS / Workers Routes**: nový apex worker na `fakan.cz/*` přebije současný
  `fakan-cz` worker. Postupuj přes mezikrok přes `mindmap.fakan.cz` (viz výše),
  ať neztratíš provoz.
- **Mindmap mobile/Capacitor**: ověř, že `dist/` se po `make build` opravdu
  vytvoří v `mindmap/dist/` (ne v rootu). `bin/build.sh` má `cd "$(dirname "$0")/.."`
  což z `mindmap/bin/` skočí do `mindmap/` — OK.
- **Tests v CI**: po pushi na `main` (později) sleduj jestli workflow projde —
  pokud ne, zkontroluj `mindmap/tests/playwright.config.js` `webServer.cwd: '..'`.
  Z `mindmap/tests/` skočí do `mindmap/`, kde žije `index.html`. Sedí.
- **FOK.md** v rootu — stále tam zůstává, je to per-repo log mezi sessionemi,
  ne per-projekt.

## Co je deployed?

Zatím **nic**. Vše čeká na ruční deploy z Macku po ověření.
