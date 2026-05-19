// Cloudflare Worker — fakan-cz.
//
// Servíruje statiku z `dist/` (asset binding) a navíc obsluhuje `/api/*`
// pro CI runner — terminál v prohlížeči přes WebSocket spouští skripty
// na serverové straně.
//
// MVP routes:
//   GET   /api/health         → { ok: true }
//   GET   /api/version        → { worker, runner }
//   GET   /api/quota?token=…  → { usage, limits } — denní využití
//   WS    /api/run?token=…    → WebSocket session, klient pošle
//                                { type: 'start', script }, server streamuje
//                                { type: 'stdout'|'stderr', line }, na konci
//                                { type: 'exit', code }.
//
// Auth pro `/api/run`: ?token=<secret> proti env.RUNNER_SECRET (nastavený
// přes `wrangler secret put RUNNER_SECRET`). Browser nemá custom WS header,
// proto query string. Constant-time compare.
//
// Quota (iterace 8): denní cap na runů a compute ms per token-hash v KV
// namespace `RUNNER_QUOTA`. Pokud KV chybí (lokální dev), gate je vypnutý.
//
// Runner v této iteraci je MOCK: echo skript zpět do streamu. Skutečný
// `bash` přijde s Cloudflare Containers v další iteraci.

import { quotaCheck, quotaBump, quotaIdent, quotaLimits, quotaRead } from './quota.js';
import {
  handlePair, handleClaim, handleMachines, handleRevoke,
  handleAgentConnect, handleBrowserConnect,
} from './tunnel.js';
export { TunnelRelay } from './tunnel-relay.js';
import { DurableObject } from 'cloudflare:workers';

// Container binding pro skutečný bash (Cloudflare Containers).
// Třída se musí exportovat i když Containers nejsou aktivní — ale aktivace
// vyžaduje runtime feature v účtu + odkomentování `containers` /
// `durable_objects` / `migrations` ve wrangler.jsonc.
//
// `this.ctx.container` je Container API exposed Cloudflare runtimem. Worker
// uvnitř startuje kontejner z `worker/Dockerfile` (Alpine + Node + bash),
// který poslouchá na :8080.
export class ShellContainer extends DurableObject {
  constructor(state, env) {
    super(state, env);
  }

  async fetch(request) {
    const c = this.ctx.container;
    if (!c) {
      return new Response('Container API není dostupné v tomto runtime', { status: 503 });
    }
    if (!c.running) {
      // enableInternet: kontejner potřebuje out-bound (curl, git clone, npm install).
      // Pokud chceš striktní sandbox, dej false a přidej allowlist přes Cloudflare
      // Egress policies.
      c.start({ enableInternet: true });
    }
    const port = c.getTcpPort(8080);
    return port.fetch(request);
  }
}

const ALLOWED_ORIGINS = new Set([
  'https://fakan.cz',
  'https://www.fakan.cz',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:8787',     // wrangler dev
  'http://127.0.0.1:8787',
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        return new Response(`api error: ${e && e.message ? e.message : e}`, { status: 500 });
      }
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, env, url) {
  const origin = request.headers.get('Origin');
  // Origin check: same-origin (Origin host = request host) vždy OK; jinak musí
  // být v allowlistu. Bez Origin (curl, server-to-server) propustíme — auth
  // přes RUNNER_SECRET stejně chrání citlivé routy.
  if (origin) {
    let sameOrigin = false;
    try { sameOrigin = new URL(origin).host === url.host; } catch {}
    if (!sameOrigin && !ALLOWED_ORIGINS.has(origin)) {
      return new Response('origin nepovolený', { status: 403 });
    }
  }

  if (url.pathname === '/api/health') {
    return json({ ok: true, ts: Date.now() });
  }
  if (url.pathname === '/api/version') {
    return json({
      worker: 'fakan-cz',
      runner: pickRunner(env),
      runnerRequested: String(env.RUNNER_IMPL || 'mock'),
      containerBound: !!env.SHELL,
      version: 1,
    });
  }
  if (url.pathname === '/api/quota') {
    return handleQuota(request, env, url);
  }
  if (url.pathname === '/api/run') {
    return handleRun(request, env, url);
  }

  // --- tunnel: pairing & machine registry (iterace 10a) --------------------
  // Browser → auth přes RUNNER_SECRET v ?token=. Agent claim je no-auth (pair
  // code sám je krátkodobý secret).
  if (url.pathname === '/api/tunnel/claim' && request.method === 'POST') {
    return handleClaim(request, env);
  }
  // Agent WS — vlastní auth přes agent token v ?token= (validuje se proti
  // KV agent:<hash>, žádný RUNNER_SECRET).
  if (url.pathname === '/api/tunnel/agent') {
    return handleAgentConnect(request, env, url);
  }
  if (url.pathname.startsWith('/api/tunnel/')) {
    if (!env.RUNNER_SECRET) {
      return new Response('RUNNER_SECRET není nastaven', { status: 503 });
    }
    const token = url.searchParams.get('token') || '';
    if (!constantTimeEqual(token, env.RUNNER_SECRET)) {
      return new Response('unauthorized', { status: 401 });
    }
    if (url.pathname === '/api/tunnel/pair' && request.method === 'POST') {
      return handlePair(request, env, token);
    }
    if (url.pathname === '/api/tunnel/machines' && request.method === 'GET') {
      return handleMachines(request, env, token);
    }
    if (url.pathname === '/api/tunnel/browser') {
      return handleBrowserConnect(request, env, url, env.RUNNER_SECRET);
    }
    // DELETE /api/tunnel/machine/<id>
    const m = url.pathname.match(/^\/api\/tunnel\/machine\/([A-Za-z0-9_-]+)$/);
    if (m && request.method === 'DELETE') {
      return handleRevoke(request, env, token, m[1]);
    }
  }

  return new Response('not found', { status: 404 });
}

async function handleQuota(request, env, url) {
  if (!env.RUNNER_SECRET) {
    return json({ enabled: false, reason: 'RUNNER_SECRET není nastaven' }, { status: 503 });
  }
  const token = url.searchParams.get('token') || '';
  if (!constantTimeEqual(token, env.RUNNER_SECRET)) {
    return new Response('unauthorized', { status: 401 });
  }
  const ident = await quotaIdent(token);
  const limits = quotaLimits(env);
  if (!env.RUNNER_QUOTA) {
    return json({ enabled: false, limits, reason: 'RUNNER_QUOTA KV nenastaveno' });
  }
  const usage = await quotaRead(env, ident);
  return json({ enabled: true, usage, limits });
}

function json(obj, init = {}) {
  return new Response(JSON.stringify(obj), {
    status: init.status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(init.headers || {}),
    },
  });
}

async function handleRun(request, env, url) {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('expected websocket upgrade', { status: 426 });
  }
  if (!env.RUNNER_SECRET) {
    return new Response('RUNNER_SECRET není nastaven (wrangler secret put RUNNER_SECRET)', { status: 503 });
  }
  const token = url.searchParams.get('token') || '';
  if (!constantTimeEqual(token, env.RUNNER_SECRET)) {
    return new Response('unauthorized', { status: 401 });
  }

  // Quota gate (před acceptem WS, ať klient dostane HTTP 429 a vidí důvod).
  const ident = await quotaIdent(token);
  const gate = await quotaCheck(env, ident);
  if (!gate.ok) {
    return json({ error: 'quota', reason: gate.reason, usage: gate.usage, limits: gate.limits }, { status: 429 });
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  let killed = false;
  let started = false;
  let startedAt = 0;
  const limits = gate.limits;

  // Hard wall-clock timeout — i mock runner musí mít cap, ať CPU nepoteče.
  let timeoutHandle = null;

  server.addEventListener('message', async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); }
    catch { send(server, { type: 'stderr', line: 'invalid JSON' }); return; }

    if (msg.type === 'kill') {
      killed = true;
      send(server, { type: 'stderr', line: '^C killed' });
      send(server, { type: 'exit', code: 130 });
      try { server.close(1000, 'killed'); } catch {}
      return;
    }
    if (msg.type === 'start') {
      if (started) {
        send(server, { type: 'stderr', line: 'session už běží' });
        return;
      }
      started = true;
      startedAt = Date.now();
      timeoutHandle = setTimeout(() => {
        if (killed) return;
        killed = true;
        const secs = Math.round(limits.runWallMs / 1000);
        send(server, { type: 'stderr', line: `timeout: překročen limit ${secs}s` });
        send(server, { type: 'exit', code: 124 });
        try { server.close(1001, 'timeout'); } catch {}
      }, limits.runWallMs);
      try {
        const impl = pickRunner(env);
        if (impl === 'container') {
          await runContainer(String(msg.script || ''), server, () => killed, env);
        } else {
          await runMock(String(msg.script || ''), server, () => killed);
        }
      } catch (e) {
        send(server, { type: 'stderr', line: 'runner error: ' + (e && e.message ? e.message : e) });
        send(server, { type: 'exit', code: 1 });
      }
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (!killed) {
        try { server.close(1000, 'done'); } catch {}
      }
      // bump usage (i pro killed runy — počítají compute time)
      try {
        await quotaBump(env, ident, 1, Date.now() - startedAt);
      } catch {}
    }
  });

  server.addEventListener('close', () => {
    killed = true;
    if (timeoutHandle) clearTimeout(timeoutHandle);
  });

  return new Response(null, { status: 101, webSocket: client });
}

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

// Vyber runner impl: env.RUNNER_IMPL ('mock' | 'container'), default 'mock'.
// Pokud uživatel požaduje 'container' ale binding chybí, vrátí 'mock'
// a stream pošle warning. Tohle umožní jeden Worker s feature flagem.
function pickRunner(env) {
  const want = String(env.RUNNER_IMPL || 'mock').toLowerCase();
  if (want === 'container' && env.SHELL) return 'container';
  return 'mock';
}

// Container runner — proxuje skript do Cloudflare Container instance přes
// jeho HTTP /run endpoint, čte NDJSON stream řádek po řádku a re-emituje
// do WebSocketu klienta.
async function runContainer(script, ws, isKilled, env) {
  // Sdílená "default" instance pro všechny runy. Per-token isolation
  // by se dala přidat přes `idFromName(tokenHash)`, ale stojí to extra
  // Container instance — pro MVP sdílíme.
  const id = env.SHELL.idFromName('default');
  const stub = env.SHELL.get(id);

  let res;
  try {
    res = await stub.fetch('http://container/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ script }),
    });
  } catch (e) {
    send(ws, { type: 'stderr', line: 'container: ' + (e.message || e) });
    send(ws, { type: 'exit', code: 1 });
    return;
  }
  if (!res.ok || !res.body) {
    send(ws, { type: 'stderr', line: `container HTTP ${res.status}` });
    send(ws, { type: 'exit', code: 1 });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    if (isKilled()) { try { await reader.cancel(); } catch {} break; }
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        send(ws, obj);
      } catch {
        send(ws, { type: 'stderr', line: 'malformed runner output: ' + line.slice(0, 200) });
      }
    }
  }
}

// Mock runner — pošle skript zpět jako stdout. Použitý dokud není
// Container binding aktivní v wrangler.jsonc + Containers v účtu.
async function runMock(script, ws, isKilled) {
  const lines = script.split('\n');
  send(ws, { type: 'stdout', line: '[fakan-cz · mock runner v1]' });
  send(ws, { type: 'stdout', line: `[přijato ${lines.length} řádků, ${script.length} bajtů]` });
  send(ws, { type: 'stdout', line: '' });
  for (const ln of lines) {
    if (isKilled()) return;
    send(ws, { type: 'stdout', line: '> ' + ln });
  }
  send(ws, { type: 'stdout', line: '' });
  send(ws, { type: 'stdout', line: '[mock: žádný skutečný shell — Cloudflare Containers přijdou v další iteraci]' });
  send(ws, { type: 'exit', code: 0 });
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
