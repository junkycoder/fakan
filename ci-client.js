// CI runner klient — token storage, endpoint config, WebSocket session.
// API:
//   ciGetToken(), ciSetToken(t)
//   ciGetEndpoint(), ciSetEndpoint(url)
//   ciHealth(), ciVersion()           — REST checky
//   ciStartRun(script, opts)          — vrátí { kill, wait }
//
// Token žije v localStorage. Stejný string musí být uložen na Workeru jako
// secret `RUNNER_SECRET`. Endpoint defaultně = same origin (kde fakan běží).

const LS_TOKEN = 'fakan:ci-token';
const LS_ENDPOINT = 'fakan:ci-endpoint';

export function ciGetToken() {
  try { return localStorage.getItem(LS_TOKEN) || ''; } catch { return ''; }
}
export function ciSetToken(token) {
  try {
    if (!token) localStorage.removeItem(LS_TOKEN);
    else localStorage.setItem(LS_TOKEN, token);
  } catch {}
}
export function ciGetEndpoint() {
  try { return localStorage.getItem(LS_ENDPOINT) || ''; } catch { return ''; }
}
export function ciSetEndpoint(url) {
  try {
    if (!url) localStorage.removeItem(LS_ENDPOINT);
    else localStorage.setItem(LS_ENDPOINT, url);
  } catch {}
}

function endpointBase() {
  const ep = ciGetEndpoint();
  if (ep) return ep.replace(/\/+$/, '');
  return location.origin;
}

function wsUrl(path, params = {}) {
  // http(s) → ws(s)
  const base = endpointBase().replace(/^http/i, 'ws');
  const u = new URL(base + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

export async function ciHealth() {
  const res = await fetch(endpointBase() + '/api/health', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

export async function ciVersion() {
  const res = await fetch(endpointBase() + '/api/version', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// Spustí WS run. Callbacks: onMessage({type, line, code}), onError(err), onClose(ev).
// Vrací { kill(), wait() }, kde wait() resolves s exit code (0 default).
export function ciStartRun(script, opts = {}) {
  const token = ciGetToken();
  if (!token) throw new Error('chybí token (zkuste `ci token <secret>`)');

  const ws = new WebSocket(wsUrl('/api/run', { token }));
  let exitCode = null;
  let exitResolve;
  const exitPromise = new Promise((r) => { exitResolve = r; });

  ws.addEventListener('open', () => {
    try {
      ws.send(JSON.stringify({ type: 'start', script: String(script || '') }));
    } catch (e) {
      opts.onError && opts.onError(e);
    }
  });

  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); }
    catch (err) { opts.onError && opts.onError(err); return; }
    if (msg.type === 'exit') {
      exitCode = msg.code;
      exitResolve(msg.code);
    }
    opts.onMessage && opts.onMessage(msg);
  });

  ws.addEventListener('close', (e) => {
    if (exitCode == null) exitResolve(0);
    opts.onClose && opts.onClose(e);
  });

  ws.addEventListener('error', (e) => {
    opts.onError && opts.onError(e);
  });

  return {
    kill() {
      try { ws.send(JSON.stringify({ type: 'kill' })); } catch {}
      try { ws.close(1000, 'client kill'); } catch {}
    },
    wait() { return exitPromise; },
    socket: ws,
  };
}
