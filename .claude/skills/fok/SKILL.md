---
name: fok
description: Rychle zapsat user-entry do FOK.md (komunikační log mezi sessionemi). Použij když uživatel napíše /fok <zpráva> nebo „fok <zpráva>".
---

# /fok

Připoj nový **user-entry** na začátek [FOK.md](../../../FOK.md). FOK.md je log mezi sessionemi (formát + smysl popsán v hlavičce souboru a v [CLAUDE.md](../../../CLAUDE.md)).

## Postup

1. Vezmi text za `/fok ` jako tělo entry.
2. Získej aktuální datum a čas:
   ```bash
   date '+%Y-%m-%d %H:%M'
   ```
3. Otevři `FOK.md`, najdi první `---` (oddělovač za header sekcí), za něj **prepend** nový blok:
   ```markdown
   ## YYYY-MM-DD HH:MM — user

   <zpráva>

   ```
4. Zapiš soubor. **Žádný commit ani push** — uživatel to commitne sám, nebo to spadne do dalšího funkčního celku.

## Pokud user napíše jen `/fok` bez textu

Zeptej se, co má zapsat. Nepiš prázdnou entry.

## Nepiš odpovědi přes skill

Tento skill je čistě pro **user-entry**. Odpověď Claudea (`— claude`) se do FOK.md píše ručně mimo skill, a to jen výjimečně (viz CLAUDE.md).
