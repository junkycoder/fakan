// Anonymní agregovaná návštěvnost.
//
// Write: env.ANALYTICS.writeDataPoint() pro každou HTML navigaci. Žádné
// cookies, žádné identifikátory — jen co Cloudflare runtime sám zná
// (request.cf.country / region / colo) + pathname.
//
// Read: GET /api/stats → JSON { total, byCountry[], days[] }. Čte z Cloudflare
// GraphQL Analytics API (account-level token `ANALYTICS_TOKEN` se scopem
// "Account Analytics:Read"). Cache 5 min v caches.default, ať GraphQL
// neřežeme každým reloadem.

const STATS_CACHE_TTL = 300; // s
const STATS_RANGE_DAYS = 30;

export function trackVisit(request, env, ctx) {
  if (!env.ANALYTICS) return;
  const cf = request.cf || {};
  const url = new URL(request.url);
  // Pathname omezený na 64 znaků — víc by se stejně neuneslo blobem.
  const path = url.pathname.slice(0, 64);
  try {
    env.ANALYTICS.writeDataPoint({
      blobs: [
        String(cf.country || 'XX'),
        String(cf.region || ''),
        String(cf.colo || ''),
        path,
      ],
      doubles: [1],
      indexes: [String(cf.country || 'XX')],
    });
  } catch {
    // best-effort, write fail tracking nikdy nesmí shodit response
  }
}

// HTML navigace = klasická top-level GET, kde browser indikuje document target.
// Fallback na Accept: text/html (starší klienti, curl s -H).
export function isPageView(request, url) {
  if (request.method !== 'GET') return false;
  if (url.pathname.startsWith('/api/')) return false;
  const dest = request.headers.get('Sec-Fetch-Dest');
  if (dest) return dest === 'document';
  const accept = request.headers.get('Accept') || '';
  return accept.includes('text/html');
}

export async function handleStats(request, env, ctx) {
  if (!env.ANALYTICS_TOKEN || !env.ANALYTICS_ACCOUNT_ID) {
    return json({ enabled: false, reason: 'ANALYTICS_TOKEN nebo ANALYTICS_ACCOUNT_ID není nastaven' }, { status: 503 });
  }

  const cache = caches.default;
  const cacheKey = new Request(new URL('/api/stats', request.url).toString(), { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let data;
  try {
    data = await queryStats(env);
  } catch (e) {
    return json({ error: 'graphql failed', detail: String(e && e.message || e) }, { status: 502 });
  }

  const resp = json({ enabled: true, ...data, ttl: STATS_CACHE_TTL }, {
    headers: { 'cache-control': `public, max-age=${STATS_CACHE_TTL}` },
  });
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}

async function queryStats(env) {
  const dataset = env.ANALYTICS_DATASET || 'fakan_visits';
  const account = env.ANALYTICS_ACCOUNT_ID;
  const since = new Date(Date.now() - STATS_RANGE_DAYS * 86400 * 1000).toISOString();
  const until = new Date().toISOString();

  // Jeden round-trip — tři aliasy v jednom dotazu (total, země, dny).
  // `sum { _sample_interval }` = odhad reálného počtu (AE sampluje vysoké zátěže).
  const query = `
    query Stats($accountTag: String!, $dataset: String!, $since: Time!, $until: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          total: workersAnalyticsEngineAdaptiveGroups(
            filter: { datasetName: $dataset, timestamp_geq: $since, timestamp_leq: $until }
            limit: 1
          ) {
            sum { sampleInterval }
          }
          byCountry: workersAnalyticsEngineAdaptiveGroups(
            filter: { datasetName: $dataset, timestamp_geq: $since, timestamp_leq: $until }
            limit: 50
            orderBy: [sum_sampleInterval_DESC]
          ) {
            dimensions { blob1 blob2 }
            sum { sampleInterval }
          }
          byDay: workersAnalyticsEngineAdaptiveGroups(
            filter: { datasetName: $dataset, timestamp_geq: $since, timestamp_leq: $until }
            limit: 100
            orderBy: [dimensions_date_ASC]
          ) {
            dimensions { date: toDate(timestamp) }
            sum { sampleInterval }
          }
        }
      }
    }
  `;

  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${env.ANALYTICS_TOKEN}`,
    },
    body: JSON.stringify({
      query,
      variables: { accountTag: account, dataset, since, until },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`graphql ${res.status}: ${body.slice(0, 200)}`);
  }
  const payload = await res.json();
  if (payload.errors && payload.errors.length) {
    throw new Error(`graphql errors: ${JSON.stringify(payload.errors).slice(0, 300)}`);
  }

  const acc = payload.data?.viewer?.accounts?.[0] || {};
  const total = sumInterval(acc.total);
  const byCountry = aggregateCountry(acc.byCountry || []);
  const days = (acc.byDay || []).map((row) => ({
    date: row.dimensions?.date || '',
    count: Number(row.sum?.sampleInterval || 0),
  })).filter((d) => d.date);

  return {
    total,
    byCountry,
    days,
    since,
    until,
    rangeDays: STATS_RANGE_DAYS,
  };
}

function sumInterval(rows) {
  if (!rows || !rows.length) return 0;
  return rows.reduce((s, r) => s + Number(r.sum?.sampleInterval || 0), 0);
}

// GraphQL vrátil řádky až per (country, region) — sečteme do per-country mapy
// a vrátíme top položky včetně volitelného rozpadu na regiony.
function aggregateCountry(rows) {
  const map = new Map();
  for (const r of rows) {
    const country = r.dimensions?.blob1 || 'XX';
    const region = r.dimensions?.blob2 || '';
    const cnt = Number(r.sum?.sampleInterval || 0);
    let entry = map.get(country);
    if (!entry) {
      entry = { country, count: 0, regions: new Map() };
      map.set(country, entry);
    }
    entry.count += cnt;
    if (region) entry.regions.set(region, (entry.regions.get(region) || 0) + cnt);
  }
  const list = Array.from(map.values()).map((e) => ({
    country: e.country,
    count: e.count,
    regions: Array.from(e.regions.entries())
      .map(([region, count]) => ({ region, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
  }));
  list.sort((a, b) => b.count - a.count);
  return list.slice(0, 20);
}

function json(obj, init = {}) {
  return new Response(JSON.stringify(obj), {
    status: init.status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': init.headers?.['cache-control'] || 'no-store',
      ...(init.headers || {}),
    },
  });
}
