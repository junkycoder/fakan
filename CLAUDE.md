# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Co to je

Osobní web `fakan.cz` — statická landing page bez buildu. Žádné npm, žádný framework, jen tři soubory: [index.html](index.html), [styles.css](styles.css), [script.js](script.js).

## Vývoj

Preview server je v [.claude/launch.json](.claude/launch.json) jako `python3 -m http.server 5173`. Spuštění přes Claude Preview MCP (`preview_start name="fakan"`) nebo ručně tím samým příkazem. Po editaci souborů je třeba ručně reload — žádný hot-reload.

Žádné testy, lint, build.

## Architektura

Single page rozdělená na fullscreen `<article class="screen">` sekce uvnitř `<main class="snap">`. Klíčové vzory:

**Snap-scroll mezi obrazovkami.** `.snap` má `scroll-snap-type: y mandatory` + `scroll-snap-stop: always`. Každý `.screen` je `100dvh`.

**Vnitřní scroll uvnitř article.** Každá obrazovka má `.screen__scroll` s vlastním `overflow-y`. `script.js` zachytává `wheel` na vnitřním scrolleru — když je na kraji (top/bottom), propaguje delta na vnější snap container, takže přepnutí na sousední obrazovku funguje plynule.

**Auto-skrývaná chrome (header + footer).** Řízeno přes `body[data-idle]` + `body[data-screen]`:
- 1,2 s bez user-aktivity → `data-idle="true"` → chrome zajede za hranu (CSS transform)
- Jakákoli interakce (`scroll`, `wheel`, `pointerdown`, `keydown`…) → `data-idle="false"` → chrome se vysune
- Na úvodu (`data-screen="uvod"`) je chrome **vždy** schované, bez ohledu na idle
- `IntersectionObserver` na `.screen` aktualizuje `data-screen` podle viditelné obrazovky a nastaví `aria-current` na nav linku

**Safe-area insets.** Header/footer i `.screen__inner` paddings respektují `env(safe-area-inset-*)` kvůli iOS notch / home-indicator a Android cutouts. `<meta viewport>` má `viewport-fit=cover`.

## Design system

CSS proměnné v `:root` ve [styles.css](styles.css):

- **Paleta:** 9 barev v `--c-*` — primární (red/yellow/blue), sekundární (orange/green/purple), terciární (pink/lime/teal). Dark mode varianty v `@media (prefers-color-scheme: dark)`.
- **Pozadí/text:** `--bg`, `--fg`, `--muted`, `--line` — záměrně off-white / off-black (ne čisté #fff/#000).
- **Selection:** `::selection` je žlutá z palety + tmavý text (highlighter look).
- **Font:** ui-monospace stack (`--mono`) jako jediný písmový druh.

## Platba (Stripe)

`<dialog id="pay-dialog">` v [index.html](index.html) je UI shell pro platbu 25 Kč **bez backendu**. Submit handler v [script.js](script.js) má TODO, kam doplnit `stripe.confirmPayment()` s `client_secret`. Chybí:

1. Publishable key
2. Backend endpoint pro Payment Intent (`amount: 2500, currency: 'czk'`)

Žádný trigger dialog momentálně neotvírá — wire-up je TODO.

## Jazyk a tonalita

Web i komunikace s uživatelem jsou v češtině s plnou diakritikou. Pro **zákaznicky orientované texty na webu** platí:

- vykání
- stručně, mile, asertivně
- minimum předpokládaných znalostí, výsledek hned
- bez emoji a marketingových klišé

## Co je v repu jinak

- [FOK.md](FOK.md) — spec pro budoucí `/fok` skill (rychlý záznam časového údaje do deníčku)
- `diary/bin.sh` — náčrt CLI pro diary entries, jen komentáře
- `contacts/`, `design/`, `projects/` — prázdné adresáře pro budoucí obsah
