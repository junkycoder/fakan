# fakan.cz

Osobní web jako mindmapa. Místo stránek máte strom, kterým se prochází do čtyř stran. Listy jsou texty. Větve můžete sdílet, zamknout nebo zpoplatnit. Ovládá se to z klávesnice.

Domácí stránka pro lidi, kteří píšou markdown, vědí, co je terminál, a chtějí mít vlastní místo na webu — bez Wordpressu, bez Notion, bez „témat".

---

## Pro koho a proč

- Solo profesionálové (designer, vývojář, autor, kouč, freelancer)
- Lidé, kteří chtějí svou homepage místo vizitky na Linktree, Carrd, Notion
- Lidé, kteří chtějí mít obsah ve svých souborech, ve svém gitu, na své doméně — bez vendor lock-inu

Vzniká pro mě, abych měl jedno plátno, kde se schází profil, texty, projekty, služby a denní práce. Otevírám si to jako homepage.

## Cíl

1. **Vlastnictví obsahu** — textové soubory v gitu. Žádná databáze, žádný cloud, žádný export.
2. **Žádný build** — `index.html` + `script.js` + `styles.css` + `tree.json`. Generuje se jedním Python skriptem. Hostuje se kdekoli.
3. **Klávesnice první, myš druhá** — vše ovladatelné šipkami a `Cmd/Ctrl+Shift+*`.
4. **Monetizace bez bariér** — některé větve veřejně, jiné placeně. Peníze chodí přímo vám.
5. **Spojení s dalšími weby** — jeden mindmap-rozcestník, který umí napojit cokoli dalšího.

## Styl

- **ASCII tree v monospace.** Spojnice `├ ─ │ ┼ └ ┌` se táhnou celou stránkou. Žádné rounded boxy, žádné gradienty.
- **Devíti-barvy paleta**: tři primární (red/yellow/blue), tři sekundární (orange/green/purple), tři terciární (pink/lime/teal). Dark mode default.
- **Off-white a off-black**, nikdy čisté `#fff`/`#000`.
- **Žádné emoji**, žádná marketingová klišé. Místo *„Try our amazing app!"* se píše, co se stane po kliknutí.
- **Vykání**. Tón je milý, stručný, asertivní.
- **Český obsah, anglická technika**. Kód anglicky, texty česky.

---

## Co umí teď

### Mindmapa
- Strom generovaný z adresářové struktury (`bin/gen-tree.py` → `tree.json`)
- Top-level uzly distribuované do 4 kvadrantů podle významu:
  - **↑ sever** — texty, deník
  - **↓ jih** — projekty
  - **→ východ** — kód a config
  - **← západ** — identita, kontakt, služby
- ASCII spojnice propojené přes celý obraz, s vizuálním oddělením skupin (prázdný řádek mezi top-level uzly)
- Pan (drag), zoom (scroll/pinch), návrat domů (`0`)

### Okna
- **Klik na uzel** = jedno hlavní okno (replace předchozího mainu)
- **Cmd+Klik** = malý preview vedle hlavního (additivní)
- **Mezerník na fokusovaném uzlu** = preview-následovník, který se posouvá s šipkami
- **Drag hlavičky** = pohyb okna, **roh** = resize, **doubleclick hlavičky** nebo **Cmd/Ctrl+Shift+M** = maximalizace
- **Aktivní okno** má žlutý header + žluté ohraničení; v navu žlutý tab

### Obsah listů
- `.md` listy mají YAML frontmatter (`title`, `slug`) + tělo
- Defaultně se v okně ukazuje **zdroj**; tlačítko `play` přepne na rendrovaný markdown
- `.html` listy se `play` otevřou jako **iframe**, automaticky se otevřou sourozenecké soubory projektu jako preview vedle
- **Web uzly** = single-file HTML snapshoty cizích webů (např. `imagineanything.cz`). Stahují se přes `python3 bin/fetch-web.py <URL> [cesta/]` — assety (CSS, JS, obrázky, fonty) se zinlinují jako `data:` URIs, 3rd-party trackery a service workery se vystřihnou. Kvadrant určí složka, do které soubor uložíte. Panel je otevře v sandboxovaném iframu a v hlavičce ukáže `↗` odkaz na originál.
- Vlastní minimální markdown renderer (nadpisy, bold/italic, code, lists, links, hr, code blocks) — žádná externí závislost

### Klávesnice

| Klávesa | Akce |
|---|---|
| `↑ ↓ ← →` (nebo `hjkl`) | Tree navigace per-kvadrant (parent / child / siblings) |
| `Enter` | Otevři jako **main** okno |
| `Mezerník` | Otevři / posuň **follower preview** |
| `Esc` | Zavři poslední preview, pak main |
| `0` | Vrať mapu domů (root na střed) |
| `Cmd/Ctrl + Shift + W` | Zavři aktivní okno |
| `Cmd/Ctrl + Shift + [ ]` | Prev / next tab v cyklu |
| `Cmd/Ctrl + Shift + 1..9` | Skok na N-tý tab |
| `Cmd/Ctrl + Shift + M` | Maximize / restore aktivního |
| `Cmd/Ctrl + Shift + N` | Nový preview z fokusovaného |

### Spodní nav
- `~/` (home) s **dropdown na top-level sekce** (hover/focus)
- `|` separator
- Otevřené panely jako **taby** — klik = bring to front, `×` = zavřít

---

## Roadmapa

### Krátkodobě (další iterace)

**Editace přímo v UI.** Tlačítka `+` u složek (nový soubor / podsložka) a `Shift + -` (smazat). Syntax: `název` = soubor, `název/` = složka. Vyžaduje lokální server (Python s POST/PUT/DELETE) nebo backendový endpoint.

**Command palette (`Cmd+K`).** Fuzzy search napříč všemi uzly a akcemi: otevřít, smazat, přejmenovat, sdílet, generovat. Hlavní brána ovládání pro klávesnicové uživatele.

**Vim mode v editoru.** Když je list otevřený a uživatel přepne na edit (`i` nebo `Enter`), ovládání jako ve vim (módy, `hjkl`, `dd`, `yy`, `:w`, …). Pravděpodobně CodeMirror 6 s vim pluginem, nebo vlastní lehčí implementace nad `textarea`.

**AI volání z uzlu (`Cmd+I`).** Pošle obsah uzlu (nebo selekci) přes Anthropic / OpenAI API. Odpověď se vloží jako nový uzel nebo do current dokumentu. Klíč v `localStorage`, nikde se neposílá.

**Snap-grid pro custom layout.** Uzly půjde tahat z dnešní auto-pozice. Při puštění se přichytí k charakter-gridu (`CHAR_W × LINE_H`), takže se pěkně chytají vedle sebe. Pozice se uloží ve frontmatteru uzlu (`x: 12, y: -4`).

### Středně (kvartál)

**Stavy větví.** `access: public | shared | locked | paid` ve frontmatteru. Vizuální indikátory v mindmapě (`●`, `→`, `🔒`, `€`). Před zobrazením se ověří přístup; pokud chybí, panel zobrazí gate (paywall nebo password input).

**Backend (Cloudflare Worker).** Jeden Worker pro:
- `POST /share` → vygeneruje krátký URL slug + share-link
- `POST /unlock` → ověří heslo, vystaví JWT v cookie
- `POST /pay` → Stripe Payment Intent (CZK), po úhradě vystaví access JWT
- `PUT /file/{path}`, `DELETE /file/{path}` → commit do GitHubu přes GitHub API
- `GET /webhook/github` → re-deploy při push

**GitHub integrace složek.** Konkrétní složka v mindmapě je napojená na git repo (`gh-mount: org/repo` ve frontmatteru kořene složky). Změny v UI commitují přímo do repa. Pull jednou za N minut nebo na webhook.

**Custom doména.** Vlastní `*.cz` → Cloudflare Pages / vlastní Worker. Setup formulářem v UI; nameservery / CNAME se nastavují automaticky tam, kde to jde. Pro doménu se postaráme i o registraci.

### Dlouhodobě (rok)

**Multi-tenancy.** Každý uživatel = vlastní fakan instance. Mindmapa nad jeho vlastními soubory, vlastní platby do jeho Stripe účtu (Stripe Connect). Naše instance je jen šablona.

**Spojení sídel.** Jeden uzel může referencovat uzel druhého uživatele / webu. Cross-link autorizovaný handshakem (oba účty potvrdí). Z mindmapy se tak stává federovaný graf.

**Plugins.** Third-party rozšíření: „kanban view nad složkou", „kalendář nad deníkem", „prezentace ze stromu". Plugin = JS modul s definovanou API; instaluje se přes URL.

**Šablony.** Hotové stromy pro typy uživatelů (designer, kouč, autor, freelancer, developer). Klik = naimportuje strukturu, uživatel vyplní obsah.

---

## Produkt

Tři tarify:

### Free
- Vlastní repo, vlastní hosting, vlastní git
- Žádné funkce, které potřebují backend (žádné sdílení odkazem, žádné placení)
- Vždy zdarma

### Hosted
- Měsíční předplatné
- My hostujeme + servisujeme backend (sdílení, zamykání, platby)
- Vlastní subdoména pod `*.fakan.cz`, nebo vlastní doména
- Stripe Connect — peníze jdou přímo vám

### Custom
- Bespoke práce nad rámec šablony
- Napojení na vaše API, custom branding, integrace s dalšími weby
- Setup domén, hostingu, e-mailu, redirectů
- Účtováno hodinově nebo paušálem

**Cílový zákazník**: solo profesionál, který chce vlastní homepage místo vizitky.

---

## Architektura

- **Frontend**: jeden `index.html` + `script.js` (ES modul) + `styles.css`. Žádný build, žádný framework.
- **Data**: `tree.json` generovaný `bin/gen-tree.py` z adresářové struktury. Listy jsou `.md` s YAML frontmatterem.
- **Backend** (až přijde čas): Cloudflare Worker — auth, payments, git proxy.
- **Hosting**: Cloudflare Pages.
- **Doména**: zákaznická nebo `*.fakan.cz`.
- **Git**: GitHub pro source + obsah. Commit přes UI = commit přes API.

## Soubory v repu

```
fakan/
├── index.html        — shell + canvas
├── script.js         — layout, render, interakce, klávesnice
├── styles.css        — paleta, layout, panely, nav
├── tree.json         — generovaná data mindmapy
├── bin/
│   └── gen-tree.py   — generátor tree.json
├── about/            — Bio, CV, Hodnoty
├── contacts/         — E-mail, Telefon, Social
├── services/         — Konzultace, Ceník, Spolupráce, balíčky
├── projects/         — fakan-cz/, kanban/, promptshare/, …
├── texty/            — úvahy, recenze
├── diary/            — deníkové záznamy po měsících
└── FOK.md            — quick-stamp záznamník
```

---

## Kdo to staví

Píše to spolu Dan Hromada a Claude (Anthropic). Iterace jsou krátké:

1. Řeknu, co chci.
2. Claude navrhne / implementuje / ukáže.
3. Společně doladíme.
4. Commit s podpisem obou.

Kontakt: [hromadadan@gmail.com](mailto:hromadadan@gmail.com).

Zdroj: [github.com/junkycoder/fakan](https://github.com/junkycoder/fakan).
