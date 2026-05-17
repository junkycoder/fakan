// fakan.cz — landing
// 1) když uživatel nescrolluje, schovej header/footer za hranu
// 2) když dojede article na konec/začátek, povol snap na další/předchozí

const IDLE_MS = 1200;

const body = document.body;
const snap = document.querySelector('[data-snap]');
const screens = Array.from(document.querySelectorAll('.screen'));

let idleTimer = null;

function markActive() {
  body.dataset.idle = 'false';
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    body.dataset.idle = 'true';
  }, IDLE_MS);
}

// start: idle
body.dataset.idle = 'true';

// jakákoli aktivita uživatele = chrome ven
['scroll', 'wheel', 'touchstart', 'touchmove', 'mousemove', 'keydown', 'pointerdown']
  .forEach((ev) => {
    window.addEventListener(ev, markActive, { passive: true, capture: true });
  });

// --- vnitřní scroll uvnitř article + přesnap na sousední ---------------------

// když je vnitřní scroll na kraji, kolečko/swipe propagujeme do snap kontejneru
screens.forEach((article) => {
  const inner = article.querySelector('.screen__scroll');
  if (!inner) return;

  inner.addEventListener('wheel', (e) => {
    const atTop = inner.scrollTop <= 0;
    const atBottom = Math.ceil(inner.scrollTop + inner.clientHeight) >= inner.scrollHeight;
    const goingDown = e.deltaY > 0;
    const goingUp = e.deltaY < 0;

    if ((goingDown && atBottom) || (goingUp && atTop)) {
      // necháme snap container převzít scroll
      snap.scrollBy({ top: e.deltaY, left: 0, behavior: 'auto' });
      e.preventDefault();
    }
  }, { passive: false });
});

// aktivní položka v navigaci podle viditelného article
const navLinks = new Map(
  Array.from(document.querySelectorAll('.nav a[href^="#"]'))
    .map((a) => [a.getAttribute('href').slice(1), a])
);

const io = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    const id = entry.target.id;
    body.dataset.screen = id;
    navLinks.forEach((link, key) => {
      if (key === id) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
  });
}, { root: snap, threshold: 0.6 });

// počáteční obrazovka = první article
body.dataset.screen = screens[0]?.id ?? '';

screens.forEach((s) => io.observe(s));

// --- € → platební dialog -----------------------------------------------------

const dialog = document.getElementById('pay-dialog');
const payTrigger = document.querySelector('[data-pay]');
const payForm = document.querySelector('[data-pay-form]');

payTrigger?.addEventListener('click', () => {
  if (typeof dialog?.showModal === 'function') dialog.showModal();
});

// klik na backdrop zavře dialog
dialog?.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close('cancel');
});

// explicitní zavírací tlačítko
document.querySelector('[data-pay-close]')?.addEventListener('click', () => {
  dialog?.close('cancel');
});

payForm?.addEventListener('submit', (e) => {
  // TODO: zde napojit Stripe.confirmPayment() s client_secret z backendu
  // (částka 25 Kč = 2500 minor units, currency: 'czk')
  e.preventDefault();
  const hint = payForm.querySelector('[data-pay-hint]');
  if (hint) hint.textContent = 'Stripe ještě není připojený — doplníme s backendem.';
});
