import { fetchProfile } from './github.js';
import { buildPrompt } from './prompt.js';
import { renderMarkdown } from './markdown.js';
import { isUnlocked, verifyReturn, startCheckout } from './paywall.js';

const DEMO_USER = 'junkycoder';
const $ = (id) => document.getElementById(id);

let profile = null;
let unlocked = false;

// ---------- pomocné ----------
function show(el) { el.hidden = false; }
function settings() {
  return {
    tagline: $('f-tagline').value,
    website: $('f-website').value,
    stack: $('f-stack').value,
    tone: $('f-tone').value,
    lang: $('f-lang').value,
    badges: $('f-badges').checked,
    emoji: $('f-emoji').checked,
  };
}

function prefill(p) {
  if (!$('f-tagline').value) $('f-tagline').value = p.bio || '';
  if (!$('f-website').value) $('f-website').value = p.blog || '';
  if (!$('f-stack').value) $('f-stack').value = p.languages.slice(0, 6).join(', ');
}

function renderProfileSummary(p) {
  const el = $('profile-summary');
  el.innerHTML = `
    <img src="${p.avatar_url}" alt="${p.login}" width="56" height="56">
    <div class="ps-meta">
      <b>${p.name} <span class="muted">@${p.login}</span></b>
      <span>${p.public_repos} repo · ${p.followers} sledujících · ${p.languages.slice(0, 4).join(', ') || '—'}</span>
    </div>`;
  show(el);
}

function refreshPrompt() {
  if (!profile) return;
  $('prompt-out').value = buildPrompt(profile, settings());
}

// ---------- demo na úvodu ----------
async function loadDemo() {
  try {
    const p = await fetchProfile(DEMO_USER);
    const prompt = buildPrompt(p, { lang: 'čeština' });
    const snippet = prompt.split('\n').slice(0, 22).join('\n');
    $('demo-body').textContent = snippet + '\n\n…(plný prompt po připojení vašeho GitHubu)';
  } catch (e) {
    $('demo-body').textContent = 'Demo se nepodařilo načíst (' + e.message + '). Nástroj níže funguje normálně.';
  }
}

// ---------- krok 1: načtení profilu ----------
async function loadProfile() {
  if (!unlocked) { openPaywall(); return; }
  const status = $('gh-status');
  status.className = 'hint';
  status.textContent = 'Načítám…';
  $('gh-load').disabled = true;
  try {
    profile = await fetchProfile($('gh-user').value);
    renderProfileSummary(profile);
    prefill(profile);
    refreshPrompt();
    show($('step-settings'));
    show($('step-prompt'));
    show($('step-result'));
    show($('howto'));
    $('howto-repo').textContent = `${profile.login}/${profile.login}`;
    status.className = 'hint ok';
    status.textContent = `Načteno: ${profile.repos.length} top repozitářů.`;
  } catch (e) {
    status.className = 'hint error';
    status.textContent = e.message;
  } finally {
    $('gh-load').disabled = false;
  }
}

// ---------- výstup / náhled / stažení ----------
function onMarkdownInput() {
  const md = $('md-in').value;
  const prev = $('md-preview');
  if (!md.trim()) {
    prev.innerHTML = '<p class="muted">Náhled se zobrazí, jakmile vlepíte markdown.</p>';
    $('md-download').disabled = true;
    return;
  }
  prev.innerHTML = renderMarkdown(md);
  $('md-download').disabled = !unlocked;
}

function downloadReadme() {
  if (!unlocked) { openPaywall(); return; }
  const blob = new Blob([$('md-in').value], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'README.md';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- paywall ----------
function openPaywall() { $('paywall').hidden = false; }
function closePaywall() { $('paywall').hidden = true; }

// ---------- copy ----------
async function copyPrompt() {
  const ta = $('prompt-out');
  try {
    await navigator.clipboard.writeText(ta.value);
  } catch {
    ta.select(); document.execCommand('copy');
  }
  const btn = $('prompt-copy');
  const orig = btn.textContent;
  btn.textContent = 'Zkopírováno';
  setTimeout(() => { btn.textContent = orig; }, 1400);
}

// ---------- init ----------
async function init() {
  unlocked = await verifyReturn() || isUnlocked();

  loadDemo();

  $('gh-load').addEventListener('click', loadProfile);
  $('gh-user').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadProfile(); });

  for (const id of ['f-tagline', 'f-website', 'f-stack', 'f-tone', 'f-lang', 'f-badges', 'f-emoji']) {
    $(id).addEventListener('input', refreshPrompt);
  }

  $('prompt-copy').addEventListener('click', copyPrompt);
  $('md-in').addEventListener('input', onMarkdownInput);
  $('md-download').addEventListener('click', downloadReadme);

  $('pay-btn').addEventListener('click', startCheckout);
  $('paywall-close').addEventListener('click', closePaywall);
  $('paywall').addEventListener('click', (e) => { if (e.target === $('paywall')) closePaywall(); });
}

init();
