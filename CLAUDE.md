# CLAUDE.md

Instrukce pro Claude Code session, která otevírá tento repo.

## Co to je

`fakan` — frontendový „přehrávač" mindmapy. Repo obsahuje **jen UI** (HTML/CSS/ES module JS) a Cloudflare Functions middleware. **Žádná data**.

Content (uživatelův osobní web) žije v separátním repu — pro doménu `fakan.cz` je to [`junkycoder/fakan.cz`](https://github.com/junkycoder/fakan.cz). Při čerstvé návštěvě (bez state v IDB) si fakan default zdroj přečte z `<meta name="fakan-default-source">` v [index.html](index.html). Formát: `github:owner/repo[@branch]`. Per-doménu lze přepsat deploy-specific verzí indexu (nebo middlewarem).

Detailní vize, roadmapa a produktové tarify v [README.md](README.md). **Před prací si ji přečti** — jinak nepochopíš, kam to směřuje.

## FOK.md = komunikační log mezi sessionemi

[FOK.md](FOK.md) je logovník, kde **uživatel** zapisuje krátké zadání / poznámky mezi sessionemi (přes skill `/fok <zpráva>` nebo přímo v editoru). **Není** to soubor s časovými razítky.

**Při startu každé nové session**:
1. Otevři [FOK.md](FOK.md) a najdi všechny `— user` entries od poslední `— claude` značky (nebo všechny, pokud žádná není).
2. To jsou nové úkoly / komentáře.
3. Vyřeš je (jeden po druhém, nebo dohromady — záleží na povaze).
4. **Odpověz v chatu**, ne ve FOK.md. Uživatel chce konverzaci v chatu, FOK je primárně jeho.

**Do FOK.md sám piš jen výjimečně** — když:
- končí session uprostřed úkolu a chceš nechat status pro další session
- uživatel řekne „zaloguj to" / „poznamenej si"
- důležitý milník (např. „nasadili jsme paywall")

Formát Claude-entry (když opravdu píšeš):
```markdown
## YYYY-MM-DD HH:MM — claude

Krátce co se stalo + commit hashe.
```
Vždy **prepend** (nahoru), zachovej časové razítko z `date '+%Y-%m-%d %H:%M'`.

## Pracovní rytmus

Krátké iterace. User řekne, co chce → navrhneš / implementuješ → ověříš v preview → **commit + push**.

### Po každé funkční změně bez explicitní žádosti:

1. Reload preview, ověř (`preview_console_logs` errors + screenshot/eval key flow)
2. **Commit + push** rovnou na `main`

User často pouští **více Claude session paralelně** s čerstvým kontextem. Aby viděl/-a práci kolegyně/-y rovnou na prod, nečekej na finální „nasaď" — commituj malé funkční celky průběžně.

### Výjimky, kdy NEcommitovat hned:
- Půlhotová featura, kde víš, že další krok ji rozbije
- Refactor měnící paths/API, vyžadující synchronizovanou změnu jinde
- Explicit user request „necommituj"

Pokud user dříve v session řekl „necommituj", drž to pro celou session, nebo dokud nepoví jinak.

## Preview

V [.claude/launch.json](.claude/launch.json) je `python3 -m http.server 5173`. Použij Claude Preview MCP:

- `preview_start name="fakan"` — idempotent, reuse-uje existující
- `preview_eval expression="location.reload()"` po editaci
- `preview_console_logs level="error"` — vždy zkontroluj po reloadu
- `preview_screenshot` — vizuální ověření klíčových toků
- `preview_eval` — programové ověření state (DOM, otevřené panely, focusedPath)

## Stack

- `index.html` + ES module JS + `styles.css` — bez frameworku. Závislosti modulů: `main.js` → `boot.js`; `boot.js` orchestruje `keyboard.js`, `panels.js`, `mindmap.js`, `sources.js`, `url.js`, `editor.js`, `search.js`; všichni sdílí `state.js` (singleton, žádné cykly).
- Cloudflare Worker `fakan-cz` se Static Assets bindingem (`not_found_handling: "single-page-application"` = SPA fallback) — GitHub repo `junkycoder/fakan`
- **Dev vs prod SPA fallback se liší!** Worker fallbackuje na 404 z asset map (cokoli, co není v `dist/` → `index.html`). `bin/serve.py` fallbackuje na Accept hlavičce (`text/html` → `index.html`, jinak normal 404). Stejné chování pro user-facing nav, ale lze zde najít drift při testech serving binárek / atypických mime typů
- Deploy: `bash bin/build.sh && CLOUDFLARE_ACCOUNT_ID=1fb320ef69377e04c649dcc880044f71 wrangler deploy` (build kopíruje `index.html`, `styles.css`, všechny `*.js` z rootu a `vendor/` do `dist/`)
- CI: `.github/workflows/test.yml` — Playwright e2e na push/PR (`tests/`, chromium). Pří selhání uploadne `playwright-report` artefakt.
- Content fetchnutý za běhu z konfigurovaného GitHub repa (default `junkycoder/fakan.cz`); user může v UI přepnout na vlastní FS handle / GitHub repo / nahraný snapshot — všechny zdroje žijí v IDB

## Architektura — klíčové věci, co je dobré znát

**Char grid.** Mindmapa je na monospace charakter gridu (`CHAR_W=8.4px × LINE_H=18px`). Trunk čáry `├ ─ │ ┼ └ ┌ ┐ ┘ ┤ ┬ ┴` se kreslí jako text v `<pre>`, ne SVG. Pozice uzlů v `(row, col)` jednotkách.

**Layout funkce v `mindmap.js`:**
- `layoutBody(children, pathPrefix, sepTop)` → grid s trunk col=0 (vertikální tree)
- `flipBodyVertical(body)` / `flipBodyHorizontal(body)` — pro NORTH / WEST kvadranty
- `composeBody(dst, body, dRow, dCol)` — vloží body do master gridu
- `buildMindmap(tree, basePath)` — orchestruje vše (root + 4 kvadranty, řeší kolize NORTH/SOUTH s vysokými EAST/WEST větvemi)
- `gridConn(g, r, c, dirs)`, `gridClearDirs(g, r, c, dirs)` — manipulace konektorů
- `charForDirs({n,s,e,w})` — mapuje set směrů → tree-character

**Module-level state (rozprostřené napříč moduly, sdílené přes `state.js`):**
- `originalTree`, `currentRootPath` — pro re-rooting (Shift+Enter na dir, klik na `~/`)
- `byPath`, `childrenByPath`, `topQuadrant` — tree index, znovu sestavený v `buildTreeIndex()` při bootu i `rebuildMindmap()`
- `mainPanel` (jeden), `previewPanels` (mapa), `activePanel`, `followerPanel` — okenní stav
- `treeNodes` — všechny uzly pro sourozeneckou auto-otevírku

**Klasifikace do kvadrantů** (`DIR_QUADRANT` v `classify`):
- ↑ NORTH = `diary`, `texty`, `notes`, `blog`, `zapisky` + `.md` v rootu
- ↓ SOUTH = `projects`, `design`, `work`, `prace`
- → EAST = `code`, `infra`, `tech`, `src` + `.html/.css/.js/.sh/.py/.json/.ts/.tsx` + dotfiles v rootu
- ← WEST = `about`, `contacts`, `kontakt`, `kontakty`, `services`, `ja`

Pokud content repo přidá novou top-level složku jiného jména, fallback je SOUTH. Pokud má smysl jinam, doplň do `DIR_QUADRANT` v `mindmap.js`.

**Klávesnice:**
- Šipky / `h j k l` = tree-nav per kvadrant (parent/child/siblings, mapování v `QUAD_ACTIONS`)
- `Enter` = main, `Space` = follower preview (2× zavře), `Shift+Enter` na dir = recenter
- `Cmd/Ctrl+Shift+W` = close active, `[ ]` cyklus tabů, `1..9` skok, `M` max, `N` preview
- `Cmd/Ctrl+←/→` = URL hierarchie (parent / forward stack) napříč kvadranty
- `Shift+H/J/K/L` = dock aktivního panelu vlevo/dolů/nahoru/vpravo (toggle — druhý stisk vrátí pozici)
- `Cmd/Ctrl+K` = otevřít globální hledání (`search.js`, najde v názvech i obsahu)
- `0` = vrátit mapu domů, `Esc` = zavřít poslední panel

**Panely a dock** (`panels.js`):
- `dockPanel(panel, zone)` — `zone ∈ 'left' | 'right' | 'top' | 'bottom' | 'full'`
- `DOCK_ZONES` definují cílové `left/top/right/bottom/width/height` (50vw nebo 50dvh, respektují `--safe-t/--safe-b` notch)
- Druhý stisk stejného směru zavolá `restorePanel` (vrátí původní geometrii)
- Plný režim (`full`) přes `Shift+M` (toggleMax), směrový dock přes Shift+HJKL nebo drag-to-edge
- DOM kompozice: `index.html` má `<main.canvas>` (mapa + labels + hits), `<nav>` (zdroj / git / home / taby), `<.panels>` kontejner pro okna, `<.empty-state>`, `<.src-loader>` (žlutý ASCII bar) a `<.badge>`

## Styl & tonalita

Pro user-facing texty (mindmapa, panel, README):
- **Vykání**
- Stručně, mile, asertivně
- Minimum předpokládaných znalostí, výsledek hned
- **Žádné emoji**, žádná marketingová klišé

V kódu:
- Komentáře česky, identifikátory anglicky
- Krátké funkce, žádné premature abstractions
- Žádné `console.log` v produkci

## Design system

Paleta v `:root` v [styles.css](styles.css):
- **9 barev** v `--c-*` — primární (red/yellow/blue), sekundární (orange/green/purple), terciární (pink/lime/teal)
- **Pozadí / text:** `--bg`, `--fg`, `--muted`, `--line` — záměrně off-white / off-black, ne čisté `#fff`/`#000`
- **Selection:** žlutá z palety + tmavý text
- **Font:** `ui-monospace` systémový stack, jediný písmový druh

Dark mode varianty v `@media (prefers-color-scheme: dark)`.

## Co NEdělat

- **Nepřidávej framework** (React, Vue, Svelte). Záměr je žádný build, vanilla ES moduly.
- **Nepoužívej npm/yarn**. Žádné `package.json` v rootu repa (testy v `tests/` mají vlastní).
- **Žádné emoji** v UI ani v kódu.
- **Žádné marketingové texty** typu „Discover the power of…".
- **Nepřidávej content do tohoto repa** (`.md` poznámky, projekty, deník atd.) — patří do content repa (`junkycoder/fakan.cz` nebo jiného, podle domény).
- **Žádné CSS in JS, žádný Tailwind** — vanilla CSS v `styles.css`.

## Soubory a struktura

```
fakan/
├── index.html             shell + canvas + <meta fakan-default-source>
├── main.js                entrypoint, importuje boot.js
├── boot.js                DOMContentLoaded sekvence, URL routing
├── mindmap.js             char-grid layout, render, klasifikace kvadrantů
├── panels.js              okenní stav, dock, taby, nav, .md/.html viewer
├── keyboard.js            klávesnice (šipky, Enter, Space, Cmd+W, Shift+HJKL, …)
├── sources.js             zdroje (FS handle / GitHub / snapshot), IDB, badge, loader
├── state.js               sdílený module-level state
├── url.js                 URL ↔ state sync
├── editor.js              md editor
├── search.js              globální hledání (názvy + obsah, Cmd/Ctrl+K nebo badge „hledat")
├── styles.css             paleta, layout, panely, nav, dock zóny
├── README.md              produktová vize + roadmapa
├── CLAUDE.md              tenhle soubor
├── FOK.md                 logovník mezi sessionemi
├── .fokrc                 glob patterny pro skrývání entries v mindmapě
├── wrangler.jsonc         Cloudflare Worker config (assets + SPA fallback)
├── .github/workflows/     CI (test.yml = Playwright e2e na push/PR)
├── bin/
│   ├── build.sh           kopíruje produkční soubory do dist/ pro wrangler deploy
│   └── serve.py           lokální dev server (SPA fallback)
├── dist/                  build output (gitignored, generovaný `bin/build.sh`)
├── tests/                 Playwright e2e (vlastní package.json, `npm test`)
├── promo/                 screenshoty pro README/landing (`npm run promo`)
├── mobile/                Capacitor iOS shell (vlastní package.json)
│   ├── package.json       @capacitor/{core,cli,ios}
│   ├── capacitor.config.json (appId: cz.fakan.app, webDir: ../dist)
│   └── ios/               Xcode projekt (App/, Podfile commit; Pods/, public/ ignore)
└── vendor/                qrcode.min.js
```

## iOS (Capacitor)

iOS appka recykluje stejný `dist/` build co web — žádná duplikace zdrojáků, pouze nativní shell v `mobile/`.

Workflow (na Macu s Xcode + CocoaPods):
```bash
cd mobile
npm install              # poprvé
npm run sync             # = bash ../bin/build.sh && cap sync ios
npm run open:ios         # otevře Xcode, dál Run/Archive
```

`cap sync ios` zkopíruje `dist/` do `ios/App/App/public/` (gitignored — vždy čerstvé) a doinstaluje pody. Bundle ID `cz.fakan.app`, app name `fakan`.

Linux/CI dokáže scaffoldnout (`cap add ios`) a vygenerovat web assety, ale samotný build vyžaduje Xcode → primárně macOS workflow.

Default zdroj na iOS je stejný jako web (`<meta name="fakan-default-source" content="github:junkycoder/fakan.cz">` v `index.html` se synchronizuje do bundlu). První spuštění tedy potřebuje net — pokud bude vadit, lze později přidat offline snapshot bundlovaný do appky.

## Když se user ptá na status

Vrať krátký souhrn:
- Co je aktuálně rozpracované
- Posledních pár commitů (`git log --oneline -5`)
- Jestli něco ještě není deployed (`git status`, `git log @{u}..`)
- Pokud běží paralelní session, navrhni, jak nezasahovat do její práce
