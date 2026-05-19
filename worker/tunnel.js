// Tunnel pairing + machines registry — fáze 3 plánu, iterace 10a.
// Drží:
//   pair:<6-mistny-kod>       → { ownerHash, label, expiresAt }    TTL 5 min
//   machine:<machineId>       → { name, ownerHash, agentTokenHash, createdAt }
//   machines:<ownerHash>      → [ { id, name, createdAt }, … ]      denorm list
//   agent:<agentTokenHash>    → { machineId, ownerHash }            reverse lookup
//
// Vše v `env.RUNNER_QUOTA` KV (sdílíme namespace, prefixy je oddělí). Pokud
// KV chybí (single-user dev bez bindingu), pairing flow vrátí 503 — bez KV
// nelze udržet stav mezi requesty (každý Worker isolate je stateless).
//
// Limity: jeden user (= jeden token-hash) může mít max 8 spárovaných strojů.

import { quotaIdent } from './quota.js';
export { TunnelRelay } from './tunnel-relay.js';

const PAIR_CODE_LEN = 6;
const PAIR_TTL_S = 300;         // 5 min
const MAX_MACHINES = 8;

function jsonResp(obj, init = {}) {
  return new Response(JSON.stringify(obj), {
    status: init.status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) },
  });
}

function randomCode(len) {
  // 6 znaků z alfabetu bez záměnných (1/I/L, 0/O). Crypto-secure.
  const ALPH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPH[b % ALPH.length];
  return out;
}

async function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let hex = '';
  for (const b of buf) hex += b.toString(16).padStart(2, '0');
  return hex;
}

async function hashHex(text) {
  const enc = new TextEncoder().encode(String(text || ''));
  const digest = await crypto.subtle.digest('SHA-256', enc);
  const arr = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 16; i++) hex += arr[i].toString(16).padStart(2, '0');
  return hex;
}

// pro WS handlery
export { hashHex as tunnelHashHex };

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  buf[6] = (buf[6] & 0x0f) | 0x40;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function requireKv(env) {
  if (!env.RUNNER_QUOTA) {
    return jsonResp({
      error: 'kv_disabled',
      reason: 'tunnel API vyžaduje KV binding RUNNER_QUOTA (viz wrangler.jsonc)',
    }, { status: 503 });
  }
  return null;
}

// --- machines:<ownerHash> array helpers ------------------------------------

async function readMachinesIndex(env, ownerHash) {
  const raw = await env.RUNNER_QUOTA.get(`machines:${ownerHash}`);
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

async function writeMachinesIndex(env, ownerHash, list) {
  if (!list || !list.length) {
    await env.RUNNER_QUOTA.delete(`machines:${ownerHash}`);
    return;
  }
  await env.RUNNER_QUOTA.put(`machines:${ownerHash}`, JSON.stringify(list));
}

// --- endpoints -------------------------------------------------------------
// User-stroj (UI) volá s ?token=<RUNNER_SECRET>. Owner identity = quotaIdent(token).
// Agent volá pair → claim flow bez tokenu, jen s 6-mistnym kódem.

// POST /api/tunnel/pair  ?token=<runner-secret>  body { label }
// Vygeneruj kód, ulož do KV s TTL, vrať { code, expiresAt }.
export async function handlePair(request, env, token) {
  const kvErr = requireKv(env);
  if (kvErr) return kvErr;
  const ownerHash = await quotaIdent(token);
  // limit: nepouštět nového pairingu pokud user překročil MAX_MACHINES
  const machines = await readMachinesIndex(env, ownerHash);
  if (machines.length >= MAX_MACHINES) {
    return jsonResp({
      error: 'limit',
      reason: `max ${MAX_MACHINES} spárovaných strojů — odebrali byste nějaký přes \`ci tunnel revoke <id>\``,
    }, { status: 429 });
  }

  let body = {};
  try { body = await request.json(); } catch {}
  const label = String(body.label || '').slice(0, 64);

  const code = randomCode(PAIR_CODE_LEN);
  const expiresAt = Date.now() + PAIR_TTL_S * 1000;
  await env.RUNNER_QUOTA.put(
    `pair:${code}`,
    JSON.stringify({ ownerHash, label, expiresAt }),
    { expirationTtl: PAIR_TTL_S },
  );
  return jsonResp({ code, expiresAt, expiresInSeconds: PAIR_TTL_S, label });
}

// POST /api/tunnel/claim  body { code, machineName }
// Bez auth — kód sám je secret (krátkodobý).
export async function handleClaim(request, env) {
  const kvErr = requireKv(env);
  if (kvErr) return kvErr;
  let body = {};
  try { body = await request.json(); } catch {}
  const code = String(body.code || '').toUpperCase().trim();
  const machineName = String(body.machineName || '').slice(0, 64) || 'unnamed';
  if (!code) return jsonResp({ error: 'missing_code' }, { status: 400 });

  const rawPair = await env.RUNNER_QUOTA.get(`pair:${code}`);
  if (!rawPair) return jsonResp({ error: 'invalid_or_expired' }, { status: 404 });
  let pair;
  try { pair = JSON.parse(rawPair); } catch { return jsonResp({ error: 'corrupt' }, { status: 500 }); }
  if (!pair.ownerHash) return jsonResp({ error: 'corrupt' }, { status: 500 });

  const machineId = uuid();
  const agentToken = await randomToken(32);
  const agentTokenHash = await hashHex(agentToken);
  const createdAt = Date.now();
  const machineEntry = {
    name: machineName,
    ownerHash: pair.ownerHash,
    agentTokenHash,
    createdAt,
  };
  await env.RUNNER_QUOTA.put(`machine:${machineId}`, JSON.stringify(machineEntry));
  await env.RUNNER_QUOTA.put(
    `agent:${agentTokenHash}`,
    JSON.stringify({ machineId, ownerHash: pair.ownerHash }),
  );

  // update index
  const list = await readMachinesIndex(env, pair.ownerHash);
  list.push({ id: machineId, name: machineName, createdAt });
  await writeMachinesIndex(env, pair.ownerHash, list);

  // pair klíč už nepotřebujeme — single-use
  await env.RUNNER_QUOTA.delete(`pair:${code}`);

  return jsonResp({
    machineId,
    agentToken,
    machineName,
  });
}

// GET /api/tunnel/machines  ?token=<runner-secret>
// Vrátí list strojů pro daného ownera.
export async function handleMachines(request, env, token) {
  const kvErr = requireKv(env);
  if (kvErr) return kvErr;
  const ownerHash = await quotaIdent(token);
  const list = await readMachinesIndex(env, ownerHash);
  return jsonResp({ machines: list });
}

// DELETE /api/tunnel/machine/:id  ?token=<runner-secret>
export async function handleRevoke(request, env, token, machineId) {
  const kvErr = requireKv(env);
  if (kvErr) return kvErr;
  const ownerHash = await quotaIdent(token);
  const rawMachine = await env.RUNNER_QUOTA.get(`machine:${machineId}`);
  if (!rawMachine) return jsonResp({ error: 'not_found' }, { status: 404 });
  let machine;
  try { machine = JSON.parse(rawMachine); } catch { machine = null; }
  if (!machine || machine.ownerHash !== ownerHash) {
    return jsonResp({ error: 'not_yours' }, { status: 403 });
  }
  // smaž machine, agent reverse-lookup, vyhoď z indexu
  await env.RUNNER_QUOTA.delete(`machine:${machineId}`);
  if (machine.agentTokenHash) {
    await env.RUNNER_QUOTA.delete(`agent:${machine.agentTokenHash}`);
  }
  const list = await readMachinesIndex(env, ownerHash);
  await writeMachinesIndex(env, ownerHash, list.filter((m) => m.id !== machineId));
  return jsonResp({ revoked: machineId });
}

// --- WebSocket connection points (iterace 10b) ----------------------------

// GET /api/tunnel/agent?token=<agentToken>  (Upgrade: websocket)
// Agent z vlastního stroje. Validuje token přes agent:<hash> v KV,
// najde machineId a připojí na DO instance pro daný stroj jako role=agent.
export async function handleAgentConnect(request, env, url) {
  if (!env.TUNNEL_RELAY) {
    return new Response('TUNNEL_RELAY binding chybí (DO nenasazený)', { status: 503 });
  }
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('expected ws upgrade', { status: 426 });
  }
  const token = url.searchParams.get('token') || '';
  if (!token) return new Response('missing token', { status: 401 });
  const tokenHash = await hashHex(token);
  const raw = await env.RUNNER_QUOTA.get(`agent:${tokenHash}`);
  if (!raw) return new Response('invalid agent token', { status: 401 });
  let info;
  try { info = JSON.parse(raw); } catch { return new Response('corrupt', { status: 500 }); }
  if (!info.machineId) return new Response('corrupt', { status: 500 });

  const id = env.TUNNEL_RELAY.idFromName(info.machineId);
  const stub = env.TUNNEL_RELAY.get(id);
  // pass-through s parametrem role=agent
  const tunnelReq = new Request(`http://relay/?role=agent`, {
    method: 'GET',
    headers: request.headers,
  });
  return stub.fetch(tunnelReq);
}

// GET /api/tunnel/browser?machine=<id>&token=<RUNNER_SECRET>  (Upgrade: ws)
// Browser strana — auth přes RUNNER_SECRET, ověř ownership machine.
export async function handleBrowserConnect(request, env, url, runnerSecret) {
  if (!env.TUNNEL_RELAY) {
    return new Response('TUNNEL_RELAY binding chybí (DO nenasazený)', { status: 503 });
  }
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('expected ws upgrade', { status: 426 });
  }
  const machineId = url.searchParams.get('machine') || '';
  const token = url.searchParams.get('token') || '';
  if (!machineId) return new Response('missing machine', { status: 400 });
  if (token !== runnerSecret) return new Response('unauthorized', { status: 401 });

  const rawMachine = await env.RUNNER_QUOTA.get(`machine:${machineId}`);
  if (!rawMachine) return new Response('machine not found', { status: 404 });
  let machine;
  try { machine = JSON.parse(rawMachine); } catch { return new Response('corrupt', { status: 500 }); }
  const ownerHash = await quotaIdent(token);
  if (machine.ownerHash !== ownerHash) {
    return new Response('not your machine', { status: 403 });
  }

  const id = env.TUNNEL_RELAY.idFromName(machineId);
  const stub = env.TUNNEL_RELAY.get(id);
  const tunnelReq = new Request(`http://relay/?role=browser`, {
    method: 'GET',
    headers: request.headers,
  });
  return stub.fetch(tunnelReq);
}
