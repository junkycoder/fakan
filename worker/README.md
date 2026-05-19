# Worker `fakan-cz` — assets + CI runner

Cloudflare Worker pro [fakan.cz](https://fakan.cz). Servíruje statiku
z `dist/` a navíc obsluhuje `/api/*` routy pro CI runner — terminálový
panel v prohlížeči přes WebSocket spouští skripty na serverové straně.

## Routes

| Endpoint | Metoda | Popis |
|---|---|---|
| `/api/health` | GET | health check, vrátí `{ ok, ts }` |
| `/api/version` | GET | info o runneru |
| `/api/run?token=…` | WS | WebSocket session pro spuštění skriptu |
| `/*` | GET | static assets (SPA fallback) |

WebSocket protokol:

```
client → server: { type: "start", script: "echo hello" }
client → server: { type: "kill" }
server → client: { type: "stdout"|"stderr", line: "..." }
server → client: { type: "exit", code: 0 }
```

## Auth

Worker validuje `?token=<secret>` v query stringu (browser nemůže přidávat
custom HTTP headers do WS hand­shaku). Token se porovnává s `RUNNER_SECRET`
secretem na Workeru. **Origin** check: povolené jen `fakan.cz`, lokální
dev (`localhost:5173`, wrangler dev na `:8787`).

V UI terminálu fakanu:
```
ci token <stejný-secret>
ci health
ci run -c "echo ahoj"
```

## Runner

V této iteraci je mock — server jen echo skript zpět jako stdout. Skutečný
`bash` exec přijde s Cloudflare Containers v další iteraci.

## Nasazení

1. Nastav secret (jednorázově):
   ```bash
   wrangler secret put RUNNER_SECRET
   # paste a long random string, např. `openssl rand -base64 32`
   ```

2. Build + deploy:
   ```bash
   bash bin/build.sh
   CLOUDFLARE_ACCOUNT_ID=… wrangler deploy
   ```

3. V terminálu fakanu nastav stejný secret:
   ```
   ci token <ten-samý-string>
   ci health
   ```

## Lokální dev

```bash
wrangler dev
```

Worker poslouchá na `http://localhost:8787`. UI fakanu pak může běžet
na `http://localhost:5173` (Python http.server) — `ci endpoint
http://localhost:8787` v terminálu fakanu přepne klienta tam.

## Co dál

- Iterace 8: per-user quota v KV namespace (denní cap na compute minutes
  + runs + R2 MB).
- Iterace 9: Cloudflare Containers binding — skutečný Alpine + bash.
  Dockerfile v `worker/Dockerfile`, container binding v `wrangler.jsonc`.
- Iterace 10: log persist do R2, `ci log <runId>` přehraje.
- Iterace 11: GitHub OAuth přes Cloudflare Access — multi-user.
