// Anonymní agregát návštěv. UI:
// - malé počítadlo v navu (zobrazené až když /api/stats odpoví číslem)
// - klik = modal s top zeměmi (a regiony) + 30denní sparkline
//
// Backend: viz worker/analytics.js. Lokální dev (bin/serve.py) endpoint nemá,
// modul tiše skončí.

const STATS_ENDPOINT = '/api/stats';

let dialogOpen = false;
let dataCache = null;

export async function mountStats() {
  const wrap = document.querySelector('[data-nav-stats]');
  const btn = document.querySelector('[data-stats-btn]');
  const countEl = document.querySelector('[data-stats-count]');
  const dialog = document.querySelector('[data-stats-dialog]');
  if (!wrap || !btn || !countEl || !dialog) return;

  btn.addEventListener('click', () => openDialog());
  dialog.querySelectorAll('[data-stats-close]').forEach((el) => {
    el.addEventListener('click', () => closeDialog());
  });
  document.addEventListener('keydown', (e) => {
    if (dialogOpen && e.key === 'Escape') {
      e.stopPropagation();
      closeDialog();
    }
  });

  const data = await fetchStats();
  if (!data || !data.enabled) return;
  dataCache = data;
  countEl.textContent = formatCount(data.total);
  wrap.hidden = false;
}

async function fetchStats() {
  try {
    const res = await fetch(STATS_ENDPOINT, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.enabled === false) return null;
    return data;
  } catch {
    return null;
  }
}

async function openDialog() {
  const dialog = document.querySelector('[data-stats-dialog]');
  const body = document.querySelector('[data-stats-body]');
  if (!dialog || !body) return;
  dialog.hidden = false;
  dialog.setAttribute('aria-hidden', 'false');
  dialogOpen = true;
  body.innerHTML = '<div class="stats-dialog__loading">Načítám…</div>';

  // Použij čerstvá data — cached číslo v navu může být desítky sekund staré.
  let data = dataCache;
  const fresh = await fetchStats();
  if (fresh) data = dataCache = fresh;

  if (!data) {
    body.innerHTML = '<div class="stats-dialog__error">Statistiky nejsou dostupné.</div>';
    return;
  }
  renderDialog(body, data);
}

function closeDialog() {
  const dialog = document.querySelector('[data-stats-dialog]');
  if (!dialog) return;
  dialog.hidden = true;
  dialog.setAttribute('aria-hidden', 'true');
  dialogOpen = false;
}

function renderDialog(body, data) {
  const total = Number(data.total || 0);
  const byCountry = Array.isArray(data.byCountry) ? data.byCountry : [];
  const days = Array.isArray(data.days) ? data.days : [];
  const range = Number(data.rangeDays || 30);

  if (total === 0) {
    body.innerHTML = `<div class="stats-dialog__empty">Zatím žádné návštěvy za posledních ${range} dní.</div>`;
    return;
  }

  const maxCountry = byCountry.reduce((m, c) => Math.max(m, Number(c.count) || 0), 0) || 1;
  const maxDay = days.reduce((m, d) => Math.max(m, Number(d.count) || 0), 0) || 1;

  const html = [];
  html.push(`
    <div class="stats-dialog__total">
      <div class="stats-dialog__total-num">${formatCount(total)}</div>
      <div class="stats-dialog__total-label">návštěv za posledních ${range} dní</div>
    </div>
  `);

  if (days.length) {
    html.push(`
      <div>
        <div class="stats-dialog__section-title">Podle dnů</div>
        <div class="stats-dialog__spark" aria-label="Spark line denních návštěv">
          ${days.map((d) => {
            const h = Math.max(2, Math.round((Number(d.count) || 0) / maxDay * 100));
            const title = `${escape(d.date)}: ${formatCount(d.count)}`;
            return `<div class="stats-dialog__spark-bar" style="height:${h}%" title="${title}"></div>`;
          }).join('')}
        </div>
      </div>
    `);
  }

  if (byCountry.length) {
    html.push(`
      <div>
        <div class="stats-dialog__section-title">Podle zemí</div>
        <div class="stats-dialog__countries">
          ${byCountry.slice(0, 10).map((c) => {
            const cnt = Number(c.count) || 0;
            const pct = Math.round(cnt / maxCountry * 100);
            const regions = Array.isArray(c.regions) ? c.regions : [];
            const regionsHtml = regions.length ? `
              <div class="stats-dialog__regions">
                ${regions.map((r) => `<span class="stats-dialog__region">${escape(r.region)} · ${formatCount(r.count)}</span>`).join('')}
              </div>
            ` : '';
            return `
              <div class="stats-dialog__country" data-country="${escape(c.country)}">
                <div class="stats-dialog__country-code">${escape(c.country)}</div>
                <div class="stats-dialog__country-bar" style="--w:${pct}%"></div>
                <div class="stats-dialog__country-count">${formatCount(cnt)}</div>
                ${regionsHtml}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `);
  }

  body.innerHTML = html.join('');
}

function formatCount(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
