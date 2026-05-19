// Cloudflare Worker — fakan-cz.
//
// Servíruje statiku z `dist/` (asset binding) a navíc obsluhuje `/api/*`
// pro CI runner — terminál v prohlížeči přes WebSocket spouští skripty
// na serverové straně.
//
// MVP routes:
//   GET   /api/health       → { ok: true }
//   GET   /api/version      → { worker, runner }
//   WS    /api/run?token=…  → WebSocket session, klient pošle
//                              { type: 'start', script }, server streamuje
//                              { type: 'stdout'|'stderr', line }, na konci
//                              { type: 'exit', code }.
//
// Auth pro `/api/run`: ?token=<secret> proti env.RUNNER_SECRET (nastavený
// přes `wrangler secret put RUNNER_SECRET`). Browser nemá custom WS header,
// proto query string. Constant-time compare.
//
// Runner v této iteraci je MOCK: echo skript zpět do streamu. Skutečný
// `bash` přijde s Cloudflare Containers v další iteraci.

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
  // Origin check — same-origin (no Origin header) i allowlist. Strict pro
  // všechny `/api/*` routes; WS handshake taky Origin posílá.
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return new Response('origin nepovolený', { status: 403 });
  }

  if (url.pathname === '/api/health') {
    return json({ ok: true, ts: Date.now() });
  }
  if (url.pathname === '/api/version') {
    return json({ worker: 'fakan-cz', runner: 'mock', version: 1 });
  }
  if (url.pathname === '/api/run') {
    return handleRun(request, env, url);
  }
  return new Response('not found', { status: 404 });
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

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  let killed = false;
  let started = false;

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
      try {
        await runMock(String(msg.script || ''), server, () => killed);
      } catch (e) {
        send(server, { type: 'stderr', line: 'runner error: ' + (e && e.message ? e.message : e) });
        send(server, { type: 'exit', code: 1 });
      }
      if (!killed) {
        try { server.close(1000, 'done'); } catch {}
      }
    }
  });

  server.addEventListener('close', () => { killed = true; });

  return new Response(null, { status: 101, webSocket: client });
}

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

// Mock runner — pošle skript zpět jako stdout. Skutečný bash exec přijde
// s Cloudflare Containers v iteraci 9. Smyčka je rychlá (žádný setTimeout),
// aby Worker neutratil CPU minuty zbytečně.
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
