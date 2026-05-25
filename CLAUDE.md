# CLAUDE.md

Instrukce pro Claude Code session, která otevírá tento repo.

> **PROBÍHÁ MIGRACE struktury** (větev `base`).
> Cíl: root = jen složky + docs. Každá top-level složka = jedna subdoména
> (`apex/`, `www/`, `new/`, `mindmap/`, …). Detail v [`README.md`](README.md)
> a v [`WIP_NOTES.md`](WIP_NOTES.md). Některé sekce níže (cesty `worker/index.js`,
> `bin/build.sh`, `index.html` v rootu, …) **budou po migraci platit relativně
> k `mindmap/`**, ne k rootu. Až bude migrace hotová, tenhle warning se smaže
> a paths se zaktualizují.

## Co to je

`fakan` — monorepo pro vše pod doménou `fakan.cz`. Každá top-level
složka = jedna subdoména s vlastním Cloudflare Workerem. Mapa subdomén
viz [`README.md`](README.md). Pravidla pro libovolného AI agenta
([`AGENTS.md`](AGENTS.md)) jsou nadmnožina; tady jsou Claude-specific
detaily a hluboký kontext k jednotlivým složkám.

**Žádný uživatelský obsah v tomhle repu.** Obsah (texty, projekty,
poznámky) žije v separátních content repech každé subdomény.

### `mindmap/` — char-grid mindmapa player

Frontendový „přehrávač" mindmapy + tenký Cloudflare Worker backend
(statika, CI runner, tunel na vlastní stroj, anonymní stats, kontaktní D1
userlist). Pro doménu `mindmap.fakan.cz` (a apex `fakan.cz`, pokud je
to aktivní projekt).

Content pro mindmap player se fetchuje za běhu z externího repa
([`junkycoder/fakan.cz`](https://github.com/junkycoder/fakan.cz) jako
default; user může v UI přepnout). Default zdroj se čte z
`<meta name="fakan-default-source">` v `mindmap/index.html`. Formát:
`github:owner/repo[@branch]`.

Detail produktové vize, roadmapa a tarify v
[`mindmap/README.md`](mindmap/README.md).

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

## Skills (`.claude/skills/`)

Repo má vlastní slash-příkazy. Pokud sedí, volej je přes Skill tool:

- **`/preview`** — start / reload / screenshot lokálního preview na `:5173`. Po každé editaci souboru.
- **`/test`** — Playwright e2e (`npm test` v `tests/`) nebo regen promo screenshotů (`npm run promo`).
- **`/fok <zpráva>`** — rychle zapsat user-entry do FOK.md.
- **`/screen-add`** — přidat fullscreen snap obrazovku do landing page (pokud fakan někde slouží jako landing).

## Preview

[.claude/launch.json](.claude/launch.json) spouští `python3 bin/serve.py 5173` (SPA fallback přes Accept hlavičku). Skill `/preview` to obaluje; přímé volání přes Claude Preview MCP:

- `preview_start name="fakan"` — idempotent, reuse-uje existující
- `preview_eval expression="location.reload()"` po editaci
- `preview_console_logs level="error"` — vždy zkontroluj po reloadu
- `preview_screenshot` — vizuální ověření klíčových toků
- `preview_eval` — programové ověření state (DOM, otevřené panely, focusedPath)

## Stack

- **Frontend:** `index.html` + ES module JS + `styles.css` — bez frameworku, bez buildu.
  Závislosti modulů: `main.js` → `boot.js`; `boot.js` orchestruje
  `keyboard.js`, `panels.js`, `mindmap.js`, `sources.js`, `url.js`,
  `editor.js`, `search.js`, `dragdrop.js`, `shake.js`, `stats.js`, `terminal.js`.
  Sdílený state v [`state.js`](state.js) (singleton, žádné cykly).
- **Worker:** [`worker/index.js`](worker/index.js) — Cloudflare Worker `fakan-cz`.
  Servíruje statiku z `dist/` (Static Assets binding, SPA fallback) + `/api/*` endpointy:
  - `/api/health`, `/api/version` — REST diagnostika
  - `/api/run?token=…` — WS pro spuštění skriptu (mock | container | tunnel agent)
  - `/api/quota?token=…` — denní limity per token (KV `RUNNER_QUOTA`)
  - `/api/stats` — anonymní agregát návštěv (Analytics Engine via GraphQL)
  - `/api/contact` — opt-in e-mail do D1 `USERLIST`
  - `/api/tunnel/*` — pairing + relay pro `fakan-agent` (Durable Object `TunnelRelay`)
- **Agent:** [`agent/`](agent/README.md) — malý Go daemon, který napojí lokální shell (Raspberry Pi, home Linux box, EC2) na fakan terminál přes Worker tunel. Multi-arch build, persistent WS, exponential backoff reconnect.
- **iOS:** [`mobile/`](mobile/) — Capacitor wrapper, recykluje stejný `dist/` build.
- **Dev vs prod SPA fallback se liší!** Worker fallbackuje na 404 z asset map (cokoli, co není v `dist/` → `index.html`). `bin/serve.py` fallbackuje na Accept hlavičce (`text/html` → `index.html`, jinak normal 404). Stejné chování pro user-facing nav, ale lze tu najít drift při testech serving binárek / atypických MIME typů.
- **CI:** [`.github/workflows/test.yml`](.github/workflows/test.yml) — Playwright e2e (chromium) na push/PR. Při selhání uploadne `playwright-report` artefakt.
- **Content** fetchnutý za běhu z konfigurovaného GitHub repa (default `junkycoder/fakan.cz`); user může v UI přepnout na vlastní FS handle / GitHub repo / nahraný snapshot — všechny zdroje žijí v IDB.

## Make targety

[`Makefile`](Makefile) je jeden vstup pro běžné workflowy (`make help` vypíše vše):

```
make dev | serve            # python3 bin/serve.py 5173
make build                  # bash bin/build.sh — připraví dist/
make deploy                 # build + wrangler deploy
make clean                  # rm -rf dist
make test                   # cd tests && npm test
make test-ui                # Playwright UI mode
make promo                  # regenerovat promo screenshoty
make report                 # otevřít poslední Playwright report
make ios [TARGET=<id>]      # build + sync + run on iOS (vyžaduje macOS + Xcode)
make ios-devices            # výpis spárovaných zařízení/simulátorů
make agent                  # go build → agent/fakan-agent
make agent-linux-arm64      # cross-build pro Pi
make agent-all              # všechny platformy
```

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
- `dragPreview` — undo callback pro dočasnou modifikaci stromu během drag&drop
- Konstanty: `CHAR_W`, `LINE_H`, `ROOT_SCALE`, `PANEL_CASCADE`, `DIR_QUADRANT`, `LS_EDIT_PREFIX`, `LS_TREE_OPS`

**Klasifikace do kvadrantů** (`DIR_QUADRANT` ve `state.js`):
- ↑ NORTH = `diary`, `texty`, `notes`, `blog`, `zapisky` + `.md` v rootu
- ↓ SOUTH = `projects`, `design`, `work`, `prace`
- → EAST = `code`, `infra`, `tech`, `src` + `.html/.css/.js/.sh/.py/.json/.ts/.tsx` + dotfiles v rootu
- ← WEST = `about`, `contacts`, `kontakt`, `kontakty`, `services`, `ja`

Pokud content repo přidá novou top-level složku jiného jména, fallback je SOUTH. Pokud má smysl jinam, doplň do `DIR_QUADRANT` ve `state.js`.

**Klávesnice:**
- Šipky / `h j k l` = tree-nav per kvadrant (parent/child/siblings, mapování v `QUAD_ACTIONS`)
- `Enter` = main, `Space` = follower preview (2× zavře), `Shift+Enter` na dir = recenter
- `Cmd/Ctrl+T` = otevřít nový **terminál** (funguje i z inputu / vim editoru / `.term`)
- `Cmd/Ctrl+K` = otevřít globální **hledání** (`search.js`, najde v názvech i obsahu)
- `Cmd/Ctrl+Shift+W` = close active, `Cmd/Ctrl+Shift+[ ]` cyklus tabů, `Cmd/Ctrl+Shift+1..9` skok, `Cmd/Ctrl+Shift+M` max, `Cmd/Ctrl+Shift+N` preview
- `Cmd/Ctrl+←/→` = URL hierarchie (parent / forward stack) napříč kvadranty
- `Shift+H/J/K/L` = dock aktivního panelu vlevo/dolů/nahoru/vpravo (toggle — druhý stisk vrátí pozici)
- `0` = vrátit mapu domů, `Esc` = zavřít poslední panel
- **Mobile:** zatřesení zařízením = otevřít terminál ([`shake.js`](shake.js), iOS 13+ vyžaduje permission po prvním tapu)

**Panely a dock** (`panels.js`):
- `dockPanel(panel, zone)` — `zone ∈ 'left' | 'right' | 'top' | 'bottom' | 'full'`
- `DOCK_ZONES` definují cílové `left/top/right/bottom/width/height` (50vw nebo 50dvh, respektují `--safe-t/--safe-b` notch)
- Druhý stisk stejného směru zavolá `restorePanel` (vrátí původní geometrii)
- Plný režim (`full`) přes `Shift+M` (toggleMax), směrový dock přes Shift+HJKL nebo drag-to-edge
- Speciální typy panelů: `terminal` (mountuje `terminal.js`), `mc` (mountuje `mc.js`), klasické file/dir/index panely (md/html viewer + vim editor)
- DOM kompozice: `index.html` má `<main.canvas>` (mapa + labels + hits), `<.srcbar>` (zdroj / git / publish / search), `<nav>` (home dropdown / stats / taby), `<.panels>` kontejner pro okna, `<.empty-state>`, `<.src-loader>` (žlutý ASCII bar), `<.stats-dialog>` a `<.badge>`

**Drag & drop** ([`dragdrop.js`](dragdrop.js)):
- Pointerdown na `.hit` → armed → pohyb > 6px aktivuje drag
- Během dragu: ghost element + hover detection + `state.dragPreview` undo callback
- Drop nad validním targetem: `recordMove()` (persist do `treeOps` v IDB + relocate LS edits)
- Drop na terminál vloží cestu uzlu do promptu (handler v `terminal.js`)
- Cancel (Escape, drop mimo): undo preview, rebuild

**Mini shell** ([`shell.js`](shell.js) + `shell-fs.js` + `shell-builtins.js` + `shell-git.js`):
- Iterace 1–4: jeden příkaz → pipes/redirekce/`&&`/`||`/`;` → `$VAR` expanze → multiline + `for`/`if`/`while` + glob
- VFS adapter (`shell-fs.js`) nad treeOps + LS edits — `cat`, `ls`, `cd`, `mkdir`, `touch`, `mv`, `cp`, `rm`, `find`, …
- Git built-iny (`shell-git.js`) — `git status`, `git diff` (unified + `--stat`), commit & push přes GitHub API
- `ci` builtin = klient pro Worker `/api/run` ([`ci-client.js`](ci-client.js)): token, endpoint, health, quota, tunnel (pair / machines / run)

**Stats badge** ([`stats.js`](stats.js)):
- Vola `/api/stats` (anonymní 30denní agregát z Analytics Engine via GraphQL)
- Pokud endpoint chybí (lokální dev, chybějící `ANALYTICS_TOKEN` secret) → tichošlapě skryje prvek
- Klik = modal s top zeměmi/regiony + sparkline

## Worker (`worker/`)

Viz [worker/README.md](worker/README.md) pro detaily routes / containerů / quota.

Soubory:
- `worker/index.js` — entry, routing `/api/*` + asset fallback
- `worker/quota.js` — denní KV gate per token-hash
- `worker/analytics.js` — `writeDataPoint` (zápis) + GraphQL handleStats (čtení)
- `worker/runner.js` — Container runtime (Alpine + Node + bash), HTTP `POST /run` → NDJSON stream
- `worker/tunnel.js` + `worker/tunnel-relay.js` — Durable Object `TunnelRelay` (pairing, agent reconnect, browser ↔ agent bridge)
- `worker/Dockerfile` — Alpine base pro Cloudflare Containers
- `worker/migrations/0001_userlist.sql` — D1 schéma pro kontakt opt-in

Bindingy ve [wrangler.jsonc](wrangler.jsonc):
- Assets `ASSETS` → `./dist`
- KV `RUNNER_QUOTA` (volitelné)
- D1 `USERLIST` (database_id viz config)
- Analytics Engine `ANALYTICS` (dataset `fakan_visits`)
- Container `SHELL` (Durable Object `ShellContainer`)
- Durable Object `TUNNEL_RELAY`

Secrets (přes `wrangler secret put`):
- `RUNNER_SECRET` — token pro `/api/run` + `/api/quota` (klient ukládá do `localStorage` jako `fakan:ci-token`)
- `ANALYTICS_TOKEN` — Cloudflare API token s `Account Analytics:Read`

## Deploy

```bash
make deploy
# = bash bin/build.sh && CLOUDFLARE_ACCOUNT_ID=… wrangler deploy
```

`bin/build.sh` kopíruje `index.html`, `styles.css`, všechny `*.js` z rootu a `vendor/` do `dist/`. **Žádný** `CLAUDE.md`, `FOK.md`, `tests/`, `promo/`, `bin/`, `worker/`, `agent/`, `mobile/` se nedostane do produkce.

`bin/deploy.sh` přidá `CLOUDFLARE_ACCOUNT_ID=1fb320ef69377e04c649dcc880044f71` a předá další argumenty wranglerovi (např. `--dry-run`).

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
- **Nepoužívej npm/yarn** v rootu repa. Žádné `package.json` v rootu (`tests/`, `mobile/` a `agent/` mají vlastní).
- **Žádné emoji** v UI ani v kódu.
- **Žádné marketingové texty** typu „Discover the power of…".
- **Nepřidávej content do tohoto repa** (`.md` poznámky, projekty, deník atd.) — patří do content repa (`junkycoder/fakan.cz` nebo jiného, podle domény).
- **Žádné CSS in JS, žádný Tailwind** — vanilla CSS v `styles.css`.
- **Neamenduj cizí commity** ani nepushuj `--force` na `main` bez explicitního pokynu.

## Soubory a struktura

```
fakan/
├── index.html             shell + canvas + <meta fakan-default-source>
├── main.js                entrypoint, importuje boot.js
├── boot.js                DOMContentLoaded sekvence, URL routing
├── state.js               sdílený module-level state + konstanty (DIR_QUADRANT, CHAR_W…)
├── mindmap.js             char-grid layout, render, klasifikace kvadrantů
├── panels.js              okenní stav, dock, taby, nav, .md/.html/terminal/mc panely
├── keyboard.js            klávesnice (šipky, Enter, Space, Cmd+T, Cmd+K, Cmd+Shift+W, Shift+HJKL, …)
├── url.js                 URL ↔ state sync
├── editor.js              md/text editor (s vim módem)
├── search.js              globální hledání (názvy + obsah, Cmd/Ctrl+K nebo badge „hledat")
├── sources.js             zdroje (FS handle / GitHub / snapshot), IDB, badge, loader
├── dragdrop.js            drag & drop přesouvání uzlů (FLIP + write-back do treeOps)
├── shake.js               shake-to-terminal na mobilu (devicemotion)
├── stats.js               anonymní stats badge + dialog (/api/stats)
├── terminal.js            terminal panel — DOM renderer + keymap nad shell.js
├── shell.js               mini shell (tokenizer, parser, executor)
├── shell-fs.js            VFS adapter nad treeOps + LS edits
├── shell-builtins.js      builtin příkazy (cat, ls, cd, echo, grep, find, …)
├── shell-git.js           git built-iny (status, diff, commit, push přes GitHub API)
├── ci-client.js           klient pro Worker /api/run (token, endpoint, WS session)
├── mc.js                  Midnight Commander dvoupanelový file manager (F3/F5/F6/F7/F8…)
├── styles.css             paleta, layout, panely, nav, srcbar, dock zóny, stats dialog
├── Makefile               make help / dev / build / deploy / test / promo / ios / agent
├── README.md              produktová vize + roadmapa
├── CLAUDE.md              tenhle soubor
├── FOK.md                 logovník mezi sessionemi
├── .fokrc                 glob patterny pro skrývání entries v mindmapě
├── wrangler.jsonc         Cloudflare Worker config (assets + KV + D1 + Analytics + Containers + DO)
├── .github/workflows/
│   └── test.yml           Playwright e2e na push/PR
├── .claude/
│   ├── launch.json        preview server (python3 bin/serve.py)
│   └── skills/            slash-příkazy: fok, preview, test, screen-add
├── bin/
│   ├── build.sh           kopíruje produkční soubory do dist/
│   ├── deploy.sh          build + wrangler deploy
│   └── serve.py           lokální dev server (SPA fallback)
├── worker/                Cloudflare Worker zdroj
│   ├── index.js           entry + routing
│   ├── quota.js           denní KV gate
│   ├── analytics.js       Analytics Engine zápis + GraphQL čtení
│   ├── runner.js          Container runtime (HTTP /run → NDJSON)
│   ├── tunnel.js          DO TunnelRelay (browser ↔ agent)
│   ├── tunnel-relay.js    tunnel relay logic
│   ├── Dockerfile         Alpine base pro Cloudflare Containers
│   ├── README.md          deploy + auth + container detaily
│   └── migrations/        D1 SQL migrations
├── agent/                 Go tunnel agent (fakan-agent)
│   ├── main.go            entry — pair / run subcommands
│   ├── go.mod / go.sum
│   └── README.md          instalace, systemd/launchd, pairing flow
├── dist/                  build output (gitignored, generovaný bin/build.sh)
├── tests/                 Playwright e2e (vlastní package.json, `npm test`)
│   ├── specs/             feature specs (badge, boot, editor, search, terminal-git, …)
│   ├── promo/             promo screenshot tests (`npm run promo`)
│   └── utils/             test helpers (GitHub mock fixture, …)
├── promo/                 commitované promo screenshoty pro README/landing
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
make ios                  # build + sync + run (interaktivní výběr zařízení)
make ios TARGET=<id>      # konkrétní zařízení / simulator (ID z `make ios-devices`)
# nebo přímo:
cd mobile
npm install               # poprvé
npm run sync              # = bash ../bin/build.sh && cap sync ios
npm run open:ios          # otevře Xcode, dál Run/Archive
```

`cap sync ios` zkopíruje `dist/` do `ios/App/App/public/` (gitignored — vždy čerstvé) a doinstaluje pody. Bundle ID `cz.fakan.app`, app name `fakan`.

Linux/CI dokáže scaffoldnout (`cap add ios`) a vygenerovat web assety, ale samotný build vyžaduje Xcode → primárně macOS workflow.

Default zdroj na iOS je stejný jako web (`<meta name="fakan-default-source" content="github:junkycoder/fakan.cz">` v `index.html` se synchronizuje do bundlu). První spuštění tedy potřebuje net — pokud bude vadit, lze později přidat offline snapshot bundlovaný do appky.

## Tunnel agent (Go)

Pokud user chce v `ci` terminálu spouštět skripty na vlastním stroji (Pi, home server, EC2), nasaďte `fakan-agent` (viz [agent/README.md](agent/README.md)):

```bash
make agent                # lokální platforma
make agent-linux-arm64    # Pi 4/5
make agent-linux-amd64    # klasický Linux server
make agent-darwin-arm64   # další Mac
```

Pairing flow: v prohlížeči `ci tunnel pair <name>` → kód → na stroji `fakan-agent pair <code> <name>` → token uložen v `~/.fakan/agent.json` (chmod 600) → `fakan-agent run` (systemd/launchd unit v README). Agent drží WS na Worker `/api/tunnel/agent`, browser komunikuje přes Worker DO `TunnelRelay`.

## Když se user ptá na status

Vrať krátký souhrn:
- Co je aktuálně rozpracované
- Posledních pár commitů (`git log --oneline -5`)
- Jestli něco ještě není deployed (`git status`, `git log @{u}..`)
- Pokud běží paralelní session, navrhni, jak nezasahovat do její práce
