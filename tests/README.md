# tests/ — e2e Playwright

Hloubkové testy pro fakan.cz. Izolováno od hlavního stacku (vlastní `package.json`, `node_modules/`). Spouští se proti lokálnímu `python3 -m http.server 5173`, který Playwright startuje sám (nebo reuse-uje existující preview).

## Setup (jednorázově)

```bash
cd tests
npm install
npx playwright install chromium
```

## Spouštění

```bash
npm test                # všechny funkční specy (specs/)
npm run promo           # regeneruje promo screenshoty do screenshots/
npm run ui              # interaktivní Playwright debugger
npm run update-baseline # update visual-regression snapshotů (po úmyslné UI změně)
npm run report          # otevři HTML report z posledního běhu
```

## Struktura

```
tests/
├── package.json
├── playwright.config.js
├── specs/               # funkční testy
│   ├── boot.spec.js
│   ├── navigation.spec.js
│   ├── panels.spec.js
│   ├── qr-tip.spec.js
│   ├── badge.spec.js
│   ├── vim-follower.spec.js
│   └── rerooting.spec.js
├── promo/
│   └── promo.spec.js    # generuje screenshots/
├── screenshots/         # promo PNG (commitované)
├── utils/
│   ├── boot.js          # bootApp, focusedPath, findAnyMd, …
│   └── selectors.js     # konstanty pro data-* selektory
└── playwright-report/   # gitignored, vzniká po každém běhu
```

## Architektura testů

- **Plain JavaScript ESM** — bez TypeScriptu, bez transpilace. Fit s „no build" duchem hlavního stacku.
- **State hook** — [main.js](../main.js) exposuje `window.__fakan = { state }`. Testy z něj čtou `focusedPath`, `currentRootPath`, `treeNodes`, `mainPanel`, `previewPanels`, `followerPanel`. Žádný runtime cost v produkci.
- **DOM selektory** — výhradně přes `data-*` atributy v aplikaci. Žádné `.querySelector` s class-name spoléháním.
- **Visual regression** — vypnutý default, opt-in přes `toHaveScreenshot` s tolerancí `maxDiffPixelRatio: 0.02`.

## Promo screenshoty

`screenshots/` obsahuje commitované PNG pro promo materiály (README, sociální sítě, demo). 3 varianty na scénář:

- `*-light.png` — světlý mód (default 1440×900, retina 2x)
- `*-dark.png` — tmavý mód
- `*-mobile.png` — Pixel 5 viewport

Regenerace po UI změně: `npm run promo`. Commit změněných PNG.

## CI

Není nastavené. Když budete chtít: Playwright má oficiální `microsoft/playwright-github-action`, stačí přidat `.github/workflows/test.yml`. Webserver běží `python3` — runner ho má v default image.

## Známé limity

- **Statický tree.json** je závislý na obsahu repa. Pokud někdo smaže všechny `.md` z `about/`, `texty/`, atd. — některé specy budou `test.skip()` (helpers vrací `null`).
- **Clipboard test** pro QR Copy běží jen v `chromium` (Firefox/WebKit Clipboard API jsou méně stabilní).
- **Vim follower test** ověřuje jen, že focus zůstává mimo `.vim` — nikoli interní vim módy.
