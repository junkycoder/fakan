---
name: test
description: Spustit Playwright e2e testy fakan.cz (npm test v tests/) nebo regenerovat promo screenshoty (npm run promo). Použij, když uživatel řekne /test, chce ověřit, že nic není rozbité, aktualizovat demo screenshoty, nebo refreshovat visual-regression baseline.
---

# /test

E2e testy běží v adresáři [tests/](../../../tests/). Playwright si sám startuje `python3 -m http.server 5173` (nebo reuse-uje preview MCP, pokud běží).

## První spuštění v session

```bash
cd tests && npm install && npx playwright install chromium
```

(Pokud `tests/node_modules` už existuje, install jen verifikuje. Browser se stahuje jen jednou.)

## Postup podle situace

**Funkční regrese po editu kódu:**
```bash
cd tests && npm test
```
Při selhání: `npm run report` otevře HTML report, kde je trace + screenshot z failu.

**Promo screenshoty pro README / demo:**
```bash
cd tests && npm run promo
```
Vznikne / aktualizuje se `tests/screenshots/*.png` (light, dark, mobile varianty). Commit změny.

**Po úmyslné UI změně (vizuální regression baseline):**
```bash
cd tests && npm run update-baseline
```
Pak vizuálně zkontroluj diffy a commit.

**Interaktivní debug:**
```bash
cd tests && npm run ui
```

## Co testy pokrývají

Specs (`tests/specs/`):
- `boot` — tree.json load, mindmap render, žádné console errors
- `navigation` — šipky napříč kvadranty, hjkl, Esc, `0`, Shift+Enter recenter
- `panels` — Enter / Space / Shift+Enter, Cmd+Shift+W/M/N/[/]/1–9
- `qr-tip` — Přispět button → dialog s QR a IBAN, Copy do clipboardu, Close
- `badge` — github + mail link v meta řádku
- `vim-follower` — Space na .md, šipky stále řídí mindmapu (ne editor)
- `rerooting` — Enter na složce, ~/ button vrátí domů

Promo (`tests/promo/`):
- 01 home, 02 panel-md, 03 qr-dialog, 04 vim-follower, 05 source-menu

## Reportování v chatu

Když test prošel: stručně potvrď („7 specs zelené"). Při selhání: jméno spec + stručná hypotéza, co se rozbilo. Detaily v `playwright-report/`.
