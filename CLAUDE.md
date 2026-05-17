# CLAUDE.md

Instrukce pro Claude Code session, která otevírá tento repo.

## Co to je

`fakan.cz` — osobní web jako mindmapa generovaná z adresářové struktury. Strom 4-kvadrantů, listy = `.md` soubory s YAML frontmatterem, žádný build.

Detailní vize, roadmapa a produktové tarify v [README.md](README.md). **Před prací si ji přečti** — jinak nepochopíš, kam to směřuje.

## FOK.md = komunikační log mezi sessionemi

[FOK.md](FOK.md) **NENÍ** soubor s časovými razítky. Je to logovník, kde si s uživatelem vyměňujeme krátké zprávy mimo session.

**Při startu každé nové session**:
1. Otevři [FOK.md](FOK.md) a najdi všechny entries od posledního `## ... — claude` směrem nahoru.
2. Ty jsou nové zadání / komentáře od uživatele.
3. Vyřeš je (jeden po druhém, nebo dohromady — záleží na povaze).
4. **Zapiš odpověď do FOK.md** nahoru: `## YYYY-MM-DD — claude` + krátký popis co jsi udělal + commit hashe.

Formát:
- Nejnovější nahoře (prepend nové entries)
- `## YYYY-MM-DD — claude` nebo `## YYYY-MM-DD — user`
- Tělo entry: krátce, jako commit message — co se dělo a proč

User často píše do FOK.md mezi session přes svůj editor (ne přes Claude). Bez tohoto kontextu bys přišel/-la o jeho zadání.

## Pracovní rytmus

Krátké iterace. User řekne, co chce → navrhneš / implementuješ → ověříš v preview → **commit + push**.

### Po každé funkční změně bez explicitní žádosti:

1. Pokud byly přidány/smazány soubory: `python3 bin/gen-tree.py`
2. Reload preview, ověř (`preview_console_logs` errors + screenshot/eval key flow)
3. **Commit + push** rovnou na `main`

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

- `index.html` + `script.js` (ES module) + `styles.css` — bez frameworku
- `bin/gen-tree.py` → `tree.json` — generátor stromu z adresářů
- Cloudflare Pages hosting, GitHub repo `junkycoder/fakan`

## Architektura — klíčové věci, co je dobré znát

**Char grid.** Mindmapa je na monospace charakter gridu (`CHAR_W=8.4px × LINE_H=18px`). Trunk čáry `├ ─ │ ┼ └ ┌ ┐ ┘ ┤ ┬ ┴` se kreslí jako text v `<pre>`, ne SVG. Pozice uzlů v `(row, col)` jednotkách.

**Layout funkce v `script.js`:**
- `layoutBody(children, pathPrefix, sepTop)` → grid s trunk col=0 (vertikální tree)
- `flipBodyVertical(body)` / `flipBodyHorizontal(body)` — pro NORTH / WEST kvadranty
- `composeBody(dst, body, dRow, dCol)` — vloží body do master gridu
- `buildMindmap(tree, basePath)` — orchestruje vše (root + 4 kvadranty, řeší kolize NORTH/SOUTH s vysokými EAST/WEST větvemi)
- `gridConn(g, r, c, dirs)`, `gridClearDirs(g, r, c, dirs)` — manipulace konektorů
- `charForDirs({n,s,e,w})` — mapuje set směrů → tree-character

**Module-level state v `script.js`:**
- `originalTree`, `currentRootPath` — pro re-rooting (Shift+Enter na dir, klik na `~/`)
- `byPath`, `childrenByPath`, `topQuadrant` — tree index, znovu sestavený v `buildTreeIndex()` při bootu i `rebuildMindmap()`
- `mainPanel` (jeden), `previewPanels` (mapa), `activePanel`, `followerPanel` — okenní stav
- `treeNodes` — všechny uzly pro sourozeneckou auto-otevírku

**Klasifikace do kvadrantů** (`DIR_QUADRANT` v `classify`):
- ↑ NORTH = `diary`, `texty`, `notes`, `blog`, `zapisky` + `.md` v rootu
- ↓ SOUTH = `projects`, `design`, `work`, `prace`
- → EAST = `code`, `infra`, `tech`, `src` + `.html/.css/.js/.sh/.py/.json/.ts/.tsx` + dotfiles v rootu
- ← WEST = `about`, `contacts`, `kontakt`, `kontakty`, `services`, `ja`

Pokud user přidá novou top-level složku jiného jména, fallback je SOUTH. Pokud má smysl jinam, doplň do `DIR_QUADRANT` v `script.js`.

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

- **Nepřidávej framework** (React, Vue, Svelte). Záměr je žádný build, jeden `script.js`.
- **Nepoužívej npm/yarn**. Žádné `package.json`.
- **Žádné emoji** v UI ani v kódu.
- **Žádné marketingové texty** typu „Discover the power of…".
- **Nekomituj** `CLAUDE.md` do generated tree — `bin/gen-tree.py` ho ignoruje, **neměň to**.
- **Žádné CSS in JS, žádný Tailwind** — vanilla CSS v `styles.css`.

## Soubory a struktura

```
fakan/
├── index.html             shell + canvas
├── script.js              layout, render, interakce, klávesnice
├── styles.css             paleta, layout, panely, nav
├── tree.json              generovaná data (commit ano)
├── README.md              produktová vize + roadmapa
├── CLAUDE.md              tenhle soubor (ignorovaný gen-tree)
├── FOK.md                 quick-stamp záznamník
├── bin/
│   └── gen-tree.py        generátor tree.json
├── about/                 identita
├── contacts/
├── services/              + balicky/
├── projects/              fakan-cz/, kanban/, promptshare/
├── diary/2026/MM/         deníkové záznamy po měsících
└── texty/                 uvahy/, recenze/
```

## Když se user ptá na status

Vrať krátký souhrn:
- Co je aktuálně rozpracované
- Posledních pár commitů (`git log --oneline -5`)
- Jestli něco ještě není deployed (`git status`, `git log @{u}..`)
- Pokud běží paralelní session, navrhni, jak nezasahovat do její práce
