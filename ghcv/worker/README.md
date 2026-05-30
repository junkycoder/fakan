# ghcv Worker — github.fakan.cz

GitHub proxy + Stripe Checkout + Resend účtenka. Čistý edge, žádný origin.

## Endpointy

| Endpoint | Metoda | Co dělá |
|---|---|---|
| `/api/github/<path>` | GET | Proxy na `api.github.com/<path>` s tokenem + KV cache (TTL 10 min) |
| `/api/checkout` | POST | Vytvoří Stripe Checkout Session, vrátí `{ url }` |
| `/api/verify?session_id=…` | GET | Ověří platbu po návratu, vrátí `{ paid, email }` |
| `/api/webhook` | POST | Stripe webhook → Resend účtenka + D1 záznam |
| `/api/health` | GET | `{ ok: true }` |

## Setup

```bash
cd ghcv/worker
npm i -g wrangler

# KV pro cache
wrangler kv namespace create GH_CACHE        # id → wrangler.jsonc

# D1 (volitelné, jen účetnictví)
wrangler d1 create ghcv-payments             # id → wrangler.jsonc
wrangler d1 migrations apply ghcv-payments

# secrets
wrangler secret put GITHUB_TOKEN             # read-only, public_repo scope
wrangler secret put STRIPE_SECRET            # sk_live_… / sk_test_…
wrangler secret put STRIPE_WEBHOOK_SECRET    # whsec_…
wrangler secret put STRIPE_PRICE_ID          # price_… (jednorázové, multi-currency)
wrangler secret put RESEND_KEY               # re_…

wrangler deploy
```

## Frontend napojení

Ve `ghcv/index.html` nastav `<meta name="ghcv-api-base">` na URL Workeru,
např. `https://ghcv-fakan.<účet>.workers.dev` nebo `https://github.fakan.cz`
(pokud Worker servíruje i Pages přes routes). Prázdné = frontend jede přímo
proti GitHub API (dev/demo, nižší rate limit, paywall jen lokálně odemčený).

## Stripe

- Produkt = jednorázové odemčení, cena multi-currency (1 €/$/25 Kč) přes jeden `price_…`.
- Apple Pay / Google Pay jdou automaticky přes `payment_method_types=card` v hosted Checkoutu
  (nutné mít ověřenou doménu v Stripe → Payment method domains).
- Webhook nastav na `https://…/api/webhook`, event `checkout.session.completed`.
