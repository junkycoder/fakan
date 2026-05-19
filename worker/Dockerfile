# fakan-runner image — minimální Node-na-Alpine s bash a coreutils.
#
# Vystaví HTTP endpoint na :8080:
#   GET  /health  → 200 OK
#   POST /run     → body { script }, vrátí NDJSON stream
#                    {"type":"stdout","line":"..."}\n
#                    {"type":"stderr","line":"..."}\n
#                    {"type":"exit","code":0}
#
# Image je určený jako Cloudflare Containers binding `SHELL`.
# Worker proxuje WebSocket z prohlížeče sem.

FROM node:22-alpine

RUN apk add --no-cache bash coreutils curl jq git

WORKDIR /app
COPY runner.js /app/runner.js

# Pro běžce nepotřebujeme nic víc; spawn bash -c v každém /run requestu.
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# nonroot user
RUN addgroup -g 1001 fakan && adduser -u 1001 -G fakan -D fakan
USER fakan

CMD ["node", "/app/runner.js"]
