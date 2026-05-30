// Cloudflare Worker pro github.fakan.cz — GitHub proxy + Stripe + Resend.
// Žádný origin server, vše na edge. Frontend (Pages) volá tyto /api/* endpointy.
//
// Bindings (wrangler.jsonc):
//   KV  GH_CACHE        — cache GitHub odpovědí (TTL ~10 min)
//   D1  PAYMENTS        — volitelný účetní záznam plateb
// Secrets (wrangler secret put):
//   GITHUB_TOKEN        — read-only token (public repo), zvedá rate limit na 5000/h
//   STRIPE_SECRET       — sk_live_… / sk_test_…
//   STRIPE_WEBHOOK_SECRET — whsec_… (ověření webhooku)
//   STRIPE_PRICE_ID     — price_… (jednorázové odemčení, multi-currency)
//   RESEND_KEY          — re_… (účtenka/faktura e-mailem)
// Vars:
//   SITE_URL            — např. https://github.fakan.cz (návratová URL Stripe)

const GH_TTL = 600; // s

function cors(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...extra,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    try {
      if (pathname.startsWith('/api/github/')) return githubProxy(request, env, url);
      if (pathname === '/api/checkout' && request.method === 'POST') return checkout(env);
      if (pathname === '/api/verify') return verify(env, url);
      if (pathname === '/api/webhook' && request.method === 'POST') return webhook(request, env);
      if (pathname === '/api/health') return json({ ok: true });
    } catch (e) {
      return json({ error: e.message || 'Server error' }, 500);
    }

    return json({ error: 'Not found' }, 404);
  },
};

// ---------- GitHub proxy + KV cache ----------
async function githubProxy(request, env, url) {
  const path = url.pathname.replace('/api/github/', '') + url.search;
  const cacheKey = `gh:${path}`;

  if (env.GH_CACHE) {
    const hit = await env.GH_CACHE.get(cacheKey);
    if (hit) return new Response(hit, { headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT', ...cors() } });
  }

  const ghRes = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ghcv.fakan.cz',
      ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
    },
  });

  const body = await ghRes.text();
  if (ghRes.ok && env.GH_CACHE) {
    await env.GH_CACHE.put(cacheKey, body, { expirationTtl: GH_TTL });
  }
  return new Response(body, {
    status: ghRes.status,
    headers: { 'Content-Type': 'application/json', 'X-Cache': 'MISS', ...cors() },
  });
}

// ---------- Stripe: form-encoded helper ----------
function form(params) {
  const p = new URLSearchParams();
  const add = (k, v) => p.append(k, String(v));
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((item, i) => {
      for (const [ik, iv] of Object.entries(item)) add(`${k}[${i}][${ik}]`, iv);
    });
    else add(k, v);
  }
  return p;
}

async function stripe(env, path, params) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params ? form(params) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Stripe error');
  return data;
}

async function stripeGet(env, path) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Stripe error');
  return data;
}

// ---------- Checkout ----------
async function checkout(env) {
  const site = env.SITE_URL || '';
  const session = await stripe(env, 'checkout/sessions', {
    mode: 'payment',
    'line_items': [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
    success_url: `${site}/?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${site}/?canceled=1`,
    customer_creation: 'always',
    'payment_method_types[0]': 'card', // Apple/Google Pay jdou přes 'card' automaticky
    billing_address_collection: 'auto',
  });
  return json({ url: session.url, id: session.id });
}

// ---------- Verify (po success redirectu) ----------
async function verify(env, url) {
  const sid = url.searchParams.get('session_id');
  if (!sid) return json({ paid: false, error: 'missing session_id' }, 400);
  const s = await stripeGet(env, `checkout/sessions/${encodeURIComponent(sid)}`);
  const paid = s.payment_status === 'paid';
  return json({ paid, email: paid ? s.customer_details?.email || null : null });
}

// ---------- Webhook → Resend účtenka + D1 záznam ----------
async function webhook(request, env) {
  const sig = request.headers.get('stripe-signature') || '';
  const raw = await request.text();

  if (env.STRIPE_WEBHOOK_SECRET) {
    const ok = await verifyStripeSig(raw, sig, env.STRIPE_WEBHOOK_SECRET);
    if (!ok) return json({ error: 'bad signature' }, 400);
  }

  const event = JSON.parse(raw);
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const email = s.customer_details?.email;
    const amount = s.amount_total;
    const currency = (s.currency || '').toUpperCase();

    if (env.PAYMENTS) {
      await env.PAYMENTS.prepare(
        'INSERT INTO payments (email, amount, currency, stripe_id, created) VALUES (?,?,?,?,?)'
      ).bind(email || '', amount || 0, currency, s.id, new Date().toISOString()).run();
    }

    if (env.RESEND_KEY && email) {
      await sendReceipt(env, email, amount, currency);
    }
  }
  return json({ received: true });
}

async function sendReceipt(env, email, amount, currency) {
  const price = (amount / 100).toFixed(2);
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'github.fakan.cz <noreply@fakan.cz>',
      to: email,
      subject: 'Účtenka — GitHub profil generátor',
      text: `Děkujeme za platbu ${price} ${currency}.\n\nNástroj máte odemčený v relaci, kde jste platili. Tento e-mail slouží jako účtenka.\n\nfakan.cz`,
    }),
  });
}

// ---------- ověření Stripe podpisu (HMAC-SHA256, bez SDK) ----------
async function verifyStripeSig(payload, header, secret) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(expected, v1);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
