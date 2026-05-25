# Worker `fakan-cz` — assets + CI runner

Cloudflare Worker pro [fakan.cz](https://fakan.cz). Servíruje statiku
z `dist/` a navíc obsluhuje `/api/*` routy pro CI runner — terminálový
panel v prohlížeči přes WebSocket spouští skripty na serverové straně.

## Routes

| Endpoint | Metoda | Popis |
|---|---|---|
| `/api/health` | GET | health check, vrátí `{ ok, ts }` |
| `/api/version` | GET | info o runneru |
| `/api/quota?token=…` | GET | denní využití runů + compute ms |
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

Worker podporuje dvě implementace runneru, výběr přes env var
`RUNNER_IMPL`:

- `mock` (default) — server echo skript zpět jako stdout, žádný shell.
  Užitečné pro vyzkoušení tunelu a UI bez nasazení Containers.
- `container` — Cloudflare Container s Alpine + Node + bash. Skutečný
  shell exec, NDJSON stream přes Worker. Vyžaduje Containers v účtu.

### Aktivace containeru (iterace 9)

1. **Containers feature v účtu** — open beta, povolení v Cloudflare
   dashboardu (Workers & Pages → Containers). Vyžaduje wrangler ≥ 4.x.

2. **Odkomentuj v `wrangler.jsonc`** sekce `containers`, `durable_objects`,
   `migrations` a vlož `"RUNNER_IMPL": "container"` do `vars`.

3. **Build image** se stane automaticky během `wrangler deploy`:
   `worker/Dockerfile` → Alpine + Node 22 + bash + coreutils + curl + jq + git.

4. **Container runtime** (`worker/runner.js`) — minimální HTTP server na
   :8080, route `POST /run` body `{ script }`, vrátí NDJSON stream:
   `{type:"stdout"|"stderr",line}` až `{type:"exit",code}`. Limity v
   env vars: `MAX_RUNTIME_MS` (default 5 min), `MAX_OUTPUT_BYTES` (1 MB).

5. **Worker proxa**: `runContainer()` v `worker/index.js` posílá script
   do Container instance přes Durable Object binding `SHELL`, streamuje
   NDJSON zpět do WebSocketu klienta řádek po řádku.

### Fallback

Pokud `env.SHELL` chybí (Containers neaktivní) a uživatel požádá
`RUNNER_IMPL=container`, Worker tichošlapě vrátí mock. Nikdy nedělá hard
fail — uživatel uvidí jen mockový výstup.

### Bezpečnost containeru

- nonroot user (uid 1001 fakan)
- HOME=/tmp, čistý PATH
- `child.kill()` po 5 min (`MAX_RUNTIME_MS`)
- Output cap 1 MB (`MAX_OUTPUT_BYTES`)
- Klient disconnect → SIGTERM child
- Žádná persistent storage v containeru — vše ephemeral; pro výsledky
  použij `ci` redirekci do localního FS terminálu (iterace 10).

## Quota (iterace 8)

Denní limit per token-hash v KV namespace `RUNNER_QUOTA`:

- `MAX_RUNS_PER_DAY` (default 100)
- `MAX_COMPUTE_MS_PER_DAY` (default 60 min)
- `MAX_RUN_WALL_MS` (default 5 min per run, hard timeout)

KV je **volitelný** — bez bindingu je gate vypnutý (pro lokální dev / single-user
provoz). Pro multi-user produkci ho zapni:

```bash
wrangler kv namespace create RUNNER_QUOTA
wrangler kv namespace create RUNNER_QUOTA --preview
# vlož ID do wrangler.jsonc (odkomentuj kv_namespaces blok)
```

V UI:
```
ci quota
# runs:     2 / 100
# compute:  0.85 / 60 min
# max wall: 300s per run
```

## Nasazení

1. **Runner secret** (jednorázově):
   ```bash
   wrangler secret put RUNNER_SECRET
   # paste long random, např. `openssl rand -base64 32`
   ```

2. **KV namespace pro quota** (volitelné, ale doporučené pro produkci).
   Cloudflare chce unikátní jména namespaců, binding ve Workeru je společný:
   ```bash
   wrangler kv namespace create RUNNER_QUOTA           # → id pro production
   wrangler kv namespace create RUNNER_QUOTA_PREVIEW   # → id pro preview
   ```
   ID vlož do `wrangler.jsonc`:
   ```jsonc
   "kv_namespaces": [
     { "binding": "RUNNER_QUOTA", "id": "<prod>", "preview_id": "<prev>" }
   ]
   ```
   (Pro single-user dev můžeš dát do obou polí to samé ID.)

3. **Docker daemon** musí běžet (Docker Desktop / OrbStack / colima) — wrangler
   během deploye spustí `docker build` z `worker/Dockerfile`, pushne image do
   Cloudflare registry a nasadí Worker s odkazem. Bez Dockeru můžeš containery
   v `wrangler.jsonc` zakomentovat — Worker pojede dál v mock režimu.

4. **Build + deploy**:
   ```bash
   make deploy
   # ekvivalent: bash bin/build.sh && wrangler deploy
   ```

5. **V terminálu fakanu**:
   ```
   ci token <ten-samý-string>
   ci health    # → {ok:true,...}
   ci run -c "echo ahoj"
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
