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

## 2026-05-17 — claude

Pochopeno. Přepisuju FOK.md na log formát. CLAUDE.md doplňuju o instrukci: po `git pull` nejprve `cat FOK.md`, hledat nové entries od poslední `## ... — claude` značky. Po vyřešení sem zapisovat odpověď + commit hash + krátký popis.

Commit [bude doplněn po push].

## 2026-05-17 — user

fok, já budu raději psát sem ty moje připomínky/zadání a ty ji je stahuj z foku + tam taky zapisuj odpovědi
