# AGENTS.md

Instrukce pro libovolného AI agenta, který otevírá tento repo (Claude
Code, Cursor, Codex, Aider, custom MCP klienti, …). Záměrně neutrální
tón — Claude-specific věci jsou v [`CLAUDE.md`](CLAUDE.md), ale 90 %
obsahu je společných.

## Co to je

`fakan` je monorepo pro vše, co běží pod doménou `fakan.cz`. Každá
top-level složka = jedna subdoména = jeden Cloudflare Worker. Viz
[`README.md`](README.md) pro mapu subdomén.

**V rootu žije jen rozcestník** (`README.md`, `CLAUDE.md`, `AGENTS.md`,
`LICENSE`, `Makefile`, dotfiles) — žádný produktový kód. Vše konkrétní
je uvnitř příslušné složky.

## Jak pracovat

1. **Identifikuj scope.** Týká se úkol konkrétní subdomény? Jdi do její
   složky a pracuj uvnitř ní. Týká se rozcestníku / konvencí celého
   repa? Pracuj v rootu.
2. **Drž se konvencí dané složky.** Každá `<složka>/README.md` popisuje
   strukturu, build flow, deploy. Nedrtěte vlastní konvenci přes ni.
3. **Commit po malých funkčních celcích.** Krátké iterace, časté pushe.
   Detail viz [`CLAUDE.md`](CLAUDE.md), sekce „Pracovní rytmus".
4. **FOK.md je komunikační log mezi sessionemi.** Při startu si přečti
   user-entries od poslední `— claude` značky a vyřeš je. Detail viz
   [`CLAUDE.md`](CLAUDE.md).

## Co NEdělat

- **Nepřidávej obsah do tohoto repa.** Obsah (texty, projekty,
  poznámky) patří do separátního content repa každé subdomény.
- **Nepřidávej framework** (React/Vue/Svelte) plošně. Pokud ho nějaká
  složka chce, ať ho má jen lokálně.
- **Žádné emoji** v kódu ani UI textech.
- **Žádné marketingové fráze** typu „Discover the power of…".
- **Neamenduj cizí commity** a nepushuj `--force` na `main` /
  produkční větve bez explicitního pokynu.
- **Nepoužívej npm/yarn v rootu repa.** Žádné `package.json` v rootu —
  jednotlivé složky si je mohou mít.

## Styl

User-facing texty:
- **Vykání**, stručně, asertivně
- Minimum předpokládaných znalostí, výsledek hned
- Češky pro texty, anglicky pro identifikátory v kódu

V kódu:
- Komentáře česky, identifikátory anglicky
- Krátké funkce, žádné premature abstractions
- Žádné `console.log` v produkci

## Cloudflare specifika

- **Workers, ne Pages.** Hosting jde přes Cloudflare Workers (assets
  bindings + případné `/api/*` endpointy).
- Každá složka má vlastní `wrangler.jsonc` a vlastní worker name.
- Secrets přes `wrangler secret put …` — nikdy je necommituj.

## Když si nejsi jistý

- Otevři [`CLAUDE.md`](CLAUDE.md) — má víc detailů (Claude-specific i
  obecných).
- Otevři README dané složky.
- Zeptej se v chatu místo plížení v repu.
