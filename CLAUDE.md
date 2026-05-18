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

- `index.html` + ES module JS (`main.js` → `boot.js` + `mindmap.js`, `panels.js`, `keyboard.js`, `sources.js`, `state.js`, `url.js`, `editor.js`) + `styles.css` — bez frameworku
- Cloudflare Pages hosting + Cloudflare Functions (`functions/`) — GitHub repo `junkycoder/fakan`
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
- Šipky = tree-nav per kvadrant (parent/child/siblings, mapování v `QUAD_ACTIONS`)
- `Enter` = main, `Space` = follower preview (2× zavře), `Shift+Enter` na dir = recenter
- `Cmd/Ctrl+Shift+W` = close active, `[ ]` cyklus tabů, `1..9` skok, `M` max, `N` preview
- `0` = vrátit mapu domů, `Esc` = zavřít poslední panel

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
├── panels.js              okenní stav, taby, nav, .md/.html viewer
├── keyboard.js            klávesnice (šipky, Enter, Space, Cmd+W, …)
├── sources.js             zdroje (FS handle / GitHub / snapshot), IDB, badge
├── state.js               sdílený module-level state
├── url.js                 URL ↔ state sync
├── editor.js              md editor
├── styles.css             paleta, layout, panely, nav
├── pravidla.html          static stránka „pravidla užití"
├── README.md              produktová vize + roadmapa
├── CLAUDE.md              tenhle soubor
├── FOK.md                 logovník mezi sessionemi
├── functions/             Cloudflare Pages Functions
│   └── _middleware.js     SPA fallback
├── bin/
│   └── serve.py           lokální dev server (SPA fallback)
├── tests/                 Playwright e2e
├── promo/                 screenshoty pro README/landing
└── vendor/                qrcode.min.js
```

## Když se user ptá na status

Vrať krátký souhrn:
- Co je aktuálně rozpracované
- Posledních pár commitů (`git log --oneline -5`)
- Jestli něco ještě není deployed (`git status`, `git log @{u}..`)
- Pokud běží paralelní session, navrhni, jak nezasahovat do její práce
