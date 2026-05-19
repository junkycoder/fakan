// Per-token denní quota v KV namespace `RUNNER_QUOTA`.
//
// Token sám se v KV neukládá — identifikace přes SHA-256 hash (prvních 16
// bajtů hex). Klíč: `quota:<hash>:<YYYY-MM-DD>`. TTL 48 h, takže včerejší
// záznamy zmizí samy.
//
// Pokud `env.RUNNER_QUOTA` chybí (lokální dev bez KV bindingu),
// quotaCheck vrátí `ok:true` a quotaBump je no-op — žádný gate.
// V produkci pro multi-user musí být KV nasazený.

export function quotaLimits(env) {
  return {
    runsPerDay: Number(env.MAX_RUNS_PER_DAY ?? 100),
    computeMsPerDay: Number(env.MAX_COMPUTE_MS_PER_DAY ?? 3_600_000), // 60 min
    runWallMs: Number(env.MAX_RUN_WALL_MS ?? 300_000),                // 5 min
  };
}

export async function quotaIdent(token) {
  const enc = new TextEncoder().encode(String(token || ''));
  const digest = await crypto.subtle.digest('SHA-256', enc);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 16; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export async function quotaRead(env, ident) {
  if (!env.RUNNER_QUOTA) return null;
  const raw = await env.RUNNER_QUOTA.get(`quota:${ident}:${todayKey()}`);
  if (!raw) return { runs: 0, computeMs: 0 };
  try {
    const j = JSON.parse(raw);
    return {
      runs: Number(j.runs || 0),
      computeMs: Number(j.computeMs || 0),
    };
  } catch {
    return { runs: 0, computeMs: 0 };
  }
}

export async function quotaBump(env, ident, deltaRuns, deltaComputeMs) {
  if (!env.RUNNER_QUOTA) return;
  const cur = (await quotaRead(env, ident)) || { runs: 0, computeMs: 0 };
  const next = {
    runs: cur.runs + deltaRuns,
    computeMs: cur.computeMs + deltaComputeMs,
  };
  await env.RUNNER_QUOTA.put(
    `quota:${ident}:${todayKey()}`,
    JSON.stringify(next),
    { expirationTtl: 172_800 } // 48 h
  );
}

// { ok, reason?, usage, limits } — pokud KV chybí, usage je null.
export async function quotaCheck(env, ident) {
  const limits = quotaLimits(env);
  if (!env.RUNNER_QUOTA) return { ok: true, usage: null, limits };
  const usage = await quotaRead(env, ident);
  if (usage.runs >= limits.runsPerDay) {
    return { ok: false, usage, limits,
      reason: `denní limit runů vyčerpaný (${usage.runs}/${limits.runsPerDay})` };
  }
  if (usage.computeMs >= limits.computeMsPerDay) {
    const mins = Math.round(limits.computeMsPerDay / 60_000);
    return { ok: false, usage, limits,
      reason: `denní compute limit vyčerpaný (~${mins} min)` };
  }
  return { ok: true, usage, limits };
}
