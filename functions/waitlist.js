// Cloudflare Pages Function — POST /waitlist
//
// Bindings (volitelné, nastavte v Pages → Settings → Functions):
//   WAITLIST_KV       — KV namespace, persistuje záznamy
//   RESEND_API_KEY    — secret, posílá kontakty do Resend Audience
//   RESEND_AUDIENCE   — Audience ID v Resend (pokud chybí, jen log)
//
// Bez bindingů funkce stále vrátí 204, ale jen loguje. To je MVP — než budou
// klíče v produkci, sběr přes Cloudflare logs nebo `wrangler tail`.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const SOURCE_TYPES = new Set(['github', 'folder', 'upload']);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function rateLimit(env, ip) {
  if (!env.WAITLIST_KV) return true;
  const key = `rl:${ip}`;
  const hit = await env.WAITLIST_KV.get(key);
  if (hit) return false;
  await env.WAITLIST_KV.put(key, '1', { expirationTtl: 60 });
  return true;
}

async function persistKV(env, record) {
  if (!env.WAITLIST_KV) return false;
  const id = `wl:${record.at}:${crypto.randomUUID()}`;
  await env.WAITLIST_KV.put(id, JSON.stringify(record), {
    metadata: { email: record.email, subdomain: record.subdomain || null },
  });
  return true;
}

async function pushResend(env, record) {
  if (!env.RESEND_API_KEY || !env.RESEND_AUDIENCE) return false;
  const res = await fetch(`https://api.resend.com/audiences/${env.RESEND_AUDIENCE}/contacts`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      email: record.email,
      unsubscribed: !record.consent,
    }),
  });
  if (!res.ok && res.status !== 409) {
    console.error('resend push failed', res.status, await res.text());
    return false;
  }
  return true;
}

export async function onRequestPost({ request, env }) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (!(await rateLimit(env, ip))) {
    return json({ error: 'rate_limited' }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  // honeypot — pokud má klient pole `hp`, je to bot
  if (body.hp) return new Response(null, { status: 204 });

  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json({ error: 'invalid_email' }, 400);

  const subdomain = body.subdomain ? String(body.subdomain).trim().toLowerCase() : null;
  if (subdomain && !SUBDOMAIN_RE.test(subdomain)) {
    return json({ error: 'invalid_subdomain' }, 400);
  }

  const sourceType = String(body.sourceType || '').trim();
  if (sourceType && !SOURCE_TYPES.has(sourceType)) {
    return json({ error: 'invalid_source' }, 400);
  }

  const record = {
    email,
    consent: !!body.consent,
    subdomain,
    wantsCustomDomain: !!body.wantsCustomDomain,
    sourceType: sourceType || null,
    ua: String(body.ua || '').slice(0, 400),
    ref: body.ref ? String(body.ref).slice(0, 400) : null,
    ip,
    at: new Date().toISOString(),
  };

  const [kv, resend] = await Promise.all([
    persistKV(env, record).catch((e) => (console.error('kv persist failed', e), false)),
    pushResend(env, record).catch((e) => (console.error('resend push failed', e), false)),
  ]);

  console.log('waitlist', JSON.stringify({ email, subdomain, sourceType, kv, resend }));
  return new Response(null, { status: 204 });
}

export function onRequest() {
  return json({ error: 'method_not_allowed' }, 405);
}
