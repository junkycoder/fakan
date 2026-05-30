// Odemčení nástroje. Bez účtů, bez cookies — unlock token žije jen v sessionStorage
// pro tu relaci. Po platbě se Stripe vrací s ?session_id=..., Worker ho ověří.

const META = document.querySelector('meta[name="ghcv-api-base"]');
const API_BASE = (META && META.content || '').replace(/\/$/, '');
const KEY = 'ghcv-unlock';

export function isUnlocked() {
  try { return sessionStorage.getItem(KEY) === '1'; } catch { return false; }
}

function setUnlocked() {
  try { sessionStorage.setItem(KEY, '1'); } catch {}
}

// Po návratu ze Stripe ověř session na Workeru a odemkni.
export async function verifyReturn() {
  const url = new URL(location.href);
  const sid = url.searchParams.get('session_id');
  if (!sid) return isUnlocked();

  // Vyčisti query, ať refresh neopakuje ověření.
  url.searchParams.delete('session_id');
  history.replaceState(null, '', url.toString());

  if (!API_BASE) { setUnlocked(); return true; } // dev bez Workeru

  try {
    const res = await fetch(`${API_BASE}/api/verify?session_id=${encodeURIComponent(sid)}`);
    const data = await res.json();
    if (res.ok && data.paid) { setUnlocked(); return true; }
  } catch {}
  return false;
}

// Spustí Stripe Checkout. Bez Workeru jen vrátí false (dev: použij „prohlížím demo").
export async function startCheckout() {
  if (!API_BASE) {
    alert('Platební endpoint není v této instanci nastavený (dev/demo).');
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/checkout`, { method: 'POST' });
    const data = await res.json();
    if (data.url) { location.href = data.url; return; }
    throw new Error(data.error || 'Checkout se nepodařilo vytvořit.');
  } catch (e) {
    alert(`Platbu se nepodařilo spustit: ${e.message}`);
  }
}
