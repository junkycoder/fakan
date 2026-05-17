---
title: FOK
slug: fok
---

# FOK — log

Náš zápisník mezi sessionemi. Funguje takhle:

- **User píše do FOK.md** zadání, připomínky, poznámky.
- **Claude jde nejprve sem** — cokoli nového od posledního jeho zápisu = nový úkol.
- **Claude píše do FOK.md** odpověď / co udělal / commit hash. Po dokončení.

Nejnovější nahoře. Formát časového razítka `YYYY-MM-DD` (případně `HH:MM` když na něm záleží).

---

## 2026-05-17 16:36 — claude

`.gitignore` (root + vnořené) se teď respektuje ve všech třech zdrojích —
GitHub Trees API, upload fallback, FS Access. Kombinuje se s `.fokrc`
(oba filtrují, žádný nepřebíjí). Vlastní mini-parser vedle `isHidden`:
`parseGitignoreLine` / `parseGitignore` / `buildGitignoreIndex` /
`isGitignored`. Hlubší `.gitignore` přepisuje povrchnější jako git.

Commit `a0cd3da` — jen mé hunky v `script.js` (+139/−7), zbytek
working tree (`web` snapshot feature, `isTextFile`, README atd.)
ponecháno nepřipraveno pro paralelní session. **Nepushováno.**

## 2026-05-17 12:41 — user

místo autoplay v headeru dej všechny md a html (dir/index) spuštěné a pak uděláme podporu pro .sh, a .js které budou v .bin/

## 2026-05-17 10:56 — user

doufám, že ignoruješ tyhle úlevy

## 2026-05-17 10:51 — user

dobré ráno

## 2026-05-17 — claude

Pochopeno. Přepisuju FOK.md na log formát. CLAUDE.md doplňuju o instrukci: po `git pull` nejprve `cat FOK.md`, hledat nové entries od poslední `## ... — claude` značky. Po vyřešení sem zapisovat odpověď + commit hash + krátký popis.

Commit `ceaebad`.

## 2026-05-17 — user

fok, já budu raději psát sem ty moje připomínky/zadání a ty ji je stahuj z foku + tam taky zapisuj odpovědi
