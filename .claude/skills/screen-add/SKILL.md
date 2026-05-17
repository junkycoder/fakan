---
name: screen-add
description: Přidat novou fullscreen snap obrazovku (article) do landing page fakan.cz. Použij, když uživatel řekne /screen-add nebo chce přidat další sekci (např. „přidej obrazovku o sobě" / „pridej kontakt").
---

# /screen-add

Architektura snap-scroll je popsaná v [CLAUDE.md](../../../CLAUDE.md#architektura). Nová obrazovka musí respektovat:

- `<article id="…" class="screen">` jako root, ID v ASCII bez diakritiky (používá se v `#hash` URL)
- uvnitř `.screen__scroll` (vlastní inner scroll, propaguje wheel na konci)
- uvnitř `.screen__inner` (paddings + safe-area insets)
- přidat link do `<nav class="nav">` v hlavičce — JS observer ho automaticky podsvítí

## Kroky

1. Vlož nový `<article>` do `<main class="snap">` v [index.html](../../../index.html) na správné místo (úvod musí zůstat první).
2. Přidej `<a href="#new-id">název</a>` do `<nav class="nav">`.
3. Pokud má obrazovka unikátní layout, přidej třídy/CSS do [styles.css](../../../styles.css) — neměň `.screen` / `.screen__scroll` / `.screen__inner` samotné.
4. Reload preview a ověř snap chování — wheel uvnitř, na kraji přepne na sousední.

## TODO

- [ ] Doplnit šablonu pro běžné typy obrazovek (text, grid, formulář)
- [ ] Pravidla pro pořadí v navigaci
