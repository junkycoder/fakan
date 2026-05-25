# new — `new.fakan.cz`

Whitelabel wizard. Uživatel naklikne typ webu / projekt → wizard vygeneruje
deployable bundle → vznikne nová subdoména `<jmeno>.fakan.cz`.

## Zamýšlený flow

1. Uživatel přijde na `new.fakan.cz`
2. Naklikne (typ, design, obsah, doména, …)
3. Klikne **Build**
4. Wizard:
   - vytvoří novou složku `<jmeno>/` v tomto repu (commit do `base` přes GitHub API)
   - vygeneruje její `public/`, `worker/`, `wrangler.jsonc`
   - spustí `wrangler deploy`
   - (později) přidá DNS record + Worker route
5. Hotový web žije na `<jmeno>.fakan.cz`

V první iteraci některé kroky půjdou ručně (wizard vyplivne zip, user
commitne sám). Postupně se to zautomatizuje.

## Struktura (až bude)

```
new/
├── public/
├── worker/         # logika buildu, GitHub API integrace
├── wrangler.jsonc  # route: new.fakan.cz/*
└── README.md
```

## Stav

WIP — zatím prázdná složka, čeká na první uživatelský klikací prototyp.
