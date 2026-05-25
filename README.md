# fakan

Monorepo pro vše, co běží pod doménou `fakan.cz` a jejími subdoménami.
Každá top-level složka = jedna subdoména s vlastním Cloudflare Workerem.

## Mapa

| Složka     | Doména                | Co tam je                                              |
| ---------- | --------------------- | ------------------------------------------------------ |
| [`apex/`](apex/) | `fakan.cz`        | Tenký Worker → transparent proxy na aktivní projekt    |
| [`www/`](www/)   | `www.fakan.cz`    | Oficiální web pro veřejnost                            |
| [`new/`](new/)   | `new.fakan.cz`    | Whitelabel wizard — naklikni, build, nová subdoména   |
| [`mindmap/`](mindmap/) | `mindmap.fakan.cz` | Char-grid mindmapa player (původní fakan)        |
| `<další>/` | `<další>.fakan.cz`    | Cokoli dalšího — vygenerované wizardem nebo ručně      |

Holé `fakan.cz` (apex) servíruje aktuálně rozpracovaný projekt — řídí se
env varem `ACTIVE_PROJECT` v apex workeru. Přepnutí jednou
`wrangler deploy --var ACTIVE_PROJECT=…` ve složce `apex/`.

## Princip

- **Root je rozcestník**, ne projekt. V rootu jen složky + `README.md`
  + `CLAUDE.md` + `AGENTS.md` + `LICENSE` + `Makefile` + dotfiles.
- **Jedna složka = jeden Worker = jedna subdoména**. Soběstačné: vlastní
  `wrangler.jsonc`, vlastní deploy, vlastní layout uvnitř.
- **Žádné sdílené JS/CSS napoprvé.** Když dva projekty potřebují totéž,
  zkopírovat. Deduplikace přijde, až to bude reálně bolet.
- **Workers, ne Pages.** Veškerý hosting přes Cloudflare Workers (assets
  bindings + případné `/api/*`).

## Workflow

```bash
# spustit konkrétní projekt lokálně
cd mindmap && make dev

# deploy konkrétního projektu
cd www && wrangler deploy

# přidat nový projekt
mkdir <jmeno> && cd <jmeno>
# … public/, worker/, wrangler.jsonc …
wrangler deploy
```

Top-level `Makefile` umí basic delegaci (`make -C mindmap dev`, atd.) —
viz [`Makefile`](Makefile).

## Co kde najít

- [`CLAUDE.md`](CLAUDE.md) — instrukce pro Claude Code session
- [`AGENTS.md`](AGENTS.md) — neutrální instrukce pro libovolného AI agenta
  (Claude, Cursor, Codex, …)
- [`FOK.md`](FOK.md) — komunikační log mezi sessionemi
- [`LICENSE`](LICENSE) — AGPL-3.0

## Kontakt

Dan Hromada, [hromada.dan@gmail.com](mailto:hromada.dan@gmail.com)
