// Terminal panel: DOM renderer + keymap. Vlastní mini-shell (`shell.js`),
// VFS adapter (`shell-fs.js`), built-in příkazy (`shell-builtins.js`).
// Veškerý state je per-mount; žádný globální state mimo session uvnitř.

import { createSession, execLine, runScriptText } from './shell.js';
import { normalizeCwd, stat } from './shell-fs.js';

// Sdílená historie napříč všemi terminálovými sessions v IDB-free localStorage.
// Cap 500 řádků, deduplikace navazujících duplicit (bash style ignoredups).
const LS_HISTORY = 'fakan:term-history';
const HISTORY_CAP = 500;

function loadHistory() {
  try {
    const raw = localStorage.getItem(LS_HISTORY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(-HISTORY_CAP) : [];
  } catch { return []; }
}

function saveHistory(history) {
  try {
    const trimmed = history.slice(-HISTORY_CAP);
    localStorage.setItem(LS_HISTORY, JSON.stringify(trimmed));
  } catch {}
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Vícejazyčný textový obsah → DOM lines. Zachová prázdné řádky uvnitř výstupu.
function appendText(scrollEl, text, cls) {
  if (text == null) return;
  const lines = String(text).split('\n');
  // pokud volající poslal jeden řádek (typicky echo / ls), nedělej zbytečný split
  for (const ln of lines) {
    const line = document.createElement('div');
    line.className = `term__line ${cls || ''}`.trim();
    line.textContent = ln;
    scrollEl.appendChild(line);
  }
}

export function mountTerminal(host, opts = {}) {
  const session = createSession({
    id: opts.id,
    cwd: opts.cwd || '',
    env: opts.env,
  });
  // sdílená historie napříč sessions
  session.history = loadHistory();
  // host hooky — fg, fakan příkazy (open/vim/dock/…) — žijí v session.host aby
  // je shell-builtins mohly volat bez kruhové závislosti na panels.js.
  session.host = {
    resumeLastEditor: opts.resumeLastEditor || null,
    listJobs: opts.listJobs || null,
    openMain: opts.openMain || null,
    openPreview: opts.openPreview || null,
    openAsFollower: opts.openAsFollower || null,
    closeAll: opts.closeAll || null,
    dockPanel: opts.dockPanel || null,
    listPanels: opts.listPanels || null,
    recenter: opts.recenter || null,
  };

  const root = document.createElement('div');
  root.className = 'term';
  root.innerHTML = `
    <div class="term__scroll" data-term-scroll></div>
    <div class="term__line term__line--prompt">
      <span class="term__prompt" data-term-prompt></span>
      <input class="term__input" data-term-input type="text"
        autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
        aria-label="terminál" />
    </div>
  `;
  host.appendChild(root);

  const scrollEl = root.querySelector('[data-term-scroll]');
  const promptEl = root.querySelector('[data-term-prompt]');
  const inputEl = root.querySelector('[data-term-input]');

  let histIdx = -1;
  let running = false;

  function promptText() {
    const c = normalizeCwd(session.cwd);
    return `~/${c}${c ? '/' : ''}$ `;
  }

  function renderPrompt() {
    promptEl.textContent = promptText();
  }

  function scrollToEnd() {
    requestAnimationFrame(() => { scrollEl.scrollTop = scrollEl.scrollHeight; });
  }

  function printEcho(cmd) {
    const line = document.createElement('div');
    line.className = 'term__line term__line--echo';
    line.innerHTML =
      `<span class="term__prompt">${escapeHtml(promptText())}</span>` +
      `<span class="term__cmd">${escapeHtml(cmd)}</span>`;
    scrollEl.appendChild(line);
  }

  function welcome() {
    const line = document.createElement('div');
    line.className = 'term__line term__line--hint';
    line.textContent = 'fakan terminál · `help` pro seznam příkazů';
    scrollEl.appendChild(line);
  }

  const io = {
    stdout: (t) => appendText(scrollEl, t, 'term__line--out'),
    stderr: (t) => appendText(scrollEl, t, 'term__line--err'),
    clear: () => { scrollEl.innerHTML = ''; },
    close: () => { opts.onClose && opts.onClose(); },
  };

  async function runCommand(cmd) {
    if (running) return;
    printEcho(cmd);
    const trimmed = cmd.trim();
    if (!trimmed) { scrollToEnd(); return; }
    // ignoredups: nepřidávat opakovaný stejný řádek
    const last = session.history[session.history.length - 1];
    if (trimmed !== last) {
      session.history.push(trimmed);
      saveHistory(session.history);
    }
    histIdx = -1;
    running = true;
    root.classList.add('is-running');
    try {
      await execLine(trimmed, session, io);
    } catch (e) {
      io.stderr(String(e && e.message ? e.message : e));
    } finally {
      running = false;
      root.classList.remove('is-running');
      renderPrompt();
      scrollToEnd();
    }
  }

  function setInputFromHistory() {
    if (histIdx >= 0 && histIdx < session.history.length) {
      inputEl.value = session.history[histIdx];
      requestAnimationFrame(() => {
        inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
      });
    }
  }

  function onKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = inputEl.value;
      inputEl.value = '';
      runCommand(cmd);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!session.history.length) return;
      if (histIdx < 0) histIdx = session.history.length - 1;
      else if (histIdx > 0) histIdx--;
      setInputFromHistory();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx < 0) return;
      if (histIdx < session.history.length - 1) { histIdx++; setInputFromHistory(); }
      else { histIdx = -1; inputEl.value = ''; }
      return;
    }
    if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      io.clear();
      return;
    }
    if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      printEcho(inputEl.value);
      const line = document.createElement('div');
      line.className = 'term__line term__line--out';
      line.textContent = '^C';
      scrollEl.appendChild(line);
      inputEl.value = '';
      histIdx = -1;
      scrollToEnd();
      return;
    }
  }

  inputEl.addEventListener('keydown', onKey);
  // klik kdekoli v terminálu → focus na input (ale nech odkazy a tlačítka)
  root.addEventListener('click', (e) => {
    if (e.target.closest('a, button')) return;
    inputEl.focus();
  });

  welcome();

  // Auto-source ~/.fakanrc (pokud existuje) — aliasy, env, prompt. Pokud má
  // syntax chybu, zobrazí ji do welcome bufferu a pokračuje.
  (async () => {
    const rc = stat('.fakanrc');
    if (rc && rc.type === 'file' && rc.node && rc.node.raw != null) {
      const line = document.createElement('div');
      line.className = 'term__line term__line--hint';
      line.textContent = 'načítám .fakanrc…';
      scrollEl.appendChild(line);
      try {
        await runScriptText(rc.node.raw, session, {
          stdout: (t) => appendText(scrollEl, t, 'term__line--out'),
          stderr: (t) => appendText(scrollEl, t, 'term__line--err'),
          clear: () => {},
          close: () => {},
        });
      } catch (e) {
        appendText(scrollEl, `.fakanrc: ${e.message || e}`, 'term__line--err');
      }
      renderPrompt();
      scrollToEnd();
    }
  })();

  renderPrompt();
  // focus dáme až po insertu do DOM (panel autofokus)
  requestAnimationFrame(() => { try { inputEl.focus(); } catch {} });

  const handle = {
    focus: () => { try { inputEl.focus(); } catch {} },
    destroy: () => {
      try { inputEl.removeEventListener('keydown', onKey); } catch {}
      try { root.remove(); } catch {}
    },
    exec: (cmd) => runCommand(cmd),
    session,
    root,
  };
  return handle;
}
