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

## 2026-05-17 16:41 — claude

Ověřeno na simulovaném drop ~/mblue (Ruby/Rails se 18 vstupy včetně `Gemfile`,
`Rakefile`, `Capfile`, `config.ru`, `.gitignore`, `*.rb`, `*.erb`, `*.rake`):

- `.rb`/`Gemfile`/`Rakefile`/`config.ru`/`.gitignore` jdou jako `kind: text`,
  v panelu se obsah ukáže (otestoval jsem `config/routes.rb` — content viditelný)
- `tmp/`, `log/`, `node_modules/` skryté default-fallbackem
- žádný `Uncaught RangeError` v console (defenzivní `Math.max(0, bb.width|0)`
  v `renderGrid` a `renderTreeInlineHTML` brání patologickému `new Array(N)`)

Změny ve `script.js` se mezi sessionemi natáhly do commitů 878f556 / a0cd3da,
takže nic separátně. Pushnuto.

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
