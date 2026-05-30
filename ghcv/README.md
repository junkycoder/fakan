# GitHub profil generátor

`github.fakan.cz` — webový nástroj, který komukoliv vygeneruje pořádný
**GitHub profile README** za pár kliků.

Připojíme váš GitHub (veřejné API), posbíráme data o vás a vašich repech a
postavíme **prompt na míru**. Ten hodíte do své oblíbené AI, odpověď vlepíte
zpět → dostanete hotový `README.md` k náhledu a stažení.

Kreativní psaní necháváme na AI, kterou už používáte — my dodáme dokonalý
kontext. Žádné účty, žádné OAuth, žádné cookies.

## Flow

1. Připojení GitHubu (username → veřejná repa přes Worker proxy).
2. Vyladění (tagline, stack, web, tón, jazyk — předvyplněno z GitHubu).
3. Vygenerování promptu + zkopírování.
4. Vlepení odpovědi z AI → živý náhled markdownu → stažení `README.md`.
5. Návod, jak založit `username/username` repo a README nahrát.

Použití na sebe je za jednorázový mikropoplatek (1 €/$/25 Kč přes Stripe,
Apple/Google Pay na jeden klik). Úvodní demo nad Fakanovým GitHubem je zdarma.

## Struktura

```
ghcv/
├── index.html      shell + landing + nástroj + paywall overlay
├── styles.css      paleta (sdílí ducha fakan design systému), layout
├── app.js          orchestrace kroků, paywall gate
├── github.js       fetch profilu + repozitářů (proxy-aware)
├── prompt.js       sestavení promptu na míru (jádro nástroje)
├── markdown.js     kompaktní MD → HTML renderer pro náhled
├── paywall.js      unlock přes Stripe (sessionStorage, bez cookies)
└── worker/         Cloudflare Worker (GitHub proxy + Stripe + Resend)
    ├── index.js
    ├── wrangler.jsonc
    ├── migrations/0001_payments.sql
    └── README.md
```

## Lokální vývoj

Frontend je statický, bez buildu. Stačí jakýkoliv HTTP server z `ghcv/`:

```bash
cd ghcv
python3 -m http.server 5174
# → http://localhost:5174
```

Bez nastaveného Workeru (`<meta name="ghcv-api-base">` prázdné) jede frontend
přímo proti veřejnému GitHub API (nižší rate limit) a paywall se v dev odemkne
lokálně. Produkční nasazení viz [worker/README.md](worker/README.md).

## Deploy

- **Frontend:** Cloudflare Pages z adresáře `ghcv/` (build command žádný,
  output `ghcv/`). Nebo přes Worker Static Assets.
- **Worker:** `cd ghcv/worker && wrangler deploy` (viz worker/README.md).
- Nastav `<meta name="ghcv-api-base">` v `index.html` na URL Workeru.
