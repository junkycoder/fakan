// Sdílené helpery pro testy. Vše předpokládá Playwright `page` object.
import { expect } from '@playwright/test';
import { SEL } from './selectors.js';

/**
 * Načte root URL a počká, až je mindmapa kompletně vyrendrovaná
 * (tree.json načten, #map má text, #labels má aspoň jeden uzel).
 */
export async function bootApp(page) {
  // V CI / lokálu bez tokenu GitHub rate-limituje (60/h pro neauth) a default-source
  // load failuje. Pokud je FAKAN_GH_TOKEN v env, přidá ho do api.github.com requestů
  // přes route interceptor — auth limit je 5000/h.
  const token = process.env.FAKAN_GH_TOKEN;
  if (token) {
    await page.route(/api\.github\.com|raw\.githubusercontent\.com/, async (route) => {
      const headers = { ...route.request().headers(), authorization: `Bearer ${token}` };
      await route.continue({ headers });
    });
  }
  await page.goto('/');
  await waitForMindmap(page);
  await page.locator(SEL.canvas).focus();
}

/**
 * Čeká na render mindmapy. Aplikace bootuje async ze tree.json,
 * takže #map text se objeví až po fetch + rebuildMindmap.
 */
export async function waitForMindmap(page) {
  await page.waitForFunction(() => {
    const f = window.__fakan;
    if (!f || !f.state) return false;
    const hasNodes = f.state.treeNodes && f.state.treeNodes.length > 0;
    const mapText = document.getElementById('map')?.textContent || '';
    return hasNodes && mapText.trim().length > 0;
  }, { timeout: 10_000 });
}

/** Vrací aktuálně fokusovanou cestu z mindmapy. */
export function focusedPath(page) {
  return page.evaluate(() => window.__fakan?.state?.focusedPath ?? null);
}

/** Vrací currentRootPath (re-root cíl). */
export function currentRootPath(page) {
  return page.evaluate(() => window.__fakan?.state?.currentRootPath ?? null);
}

/** Vrací počet otevřených panelů (main + preview). */
export async function panelCount(page) {
  return page.locator(SEL.panel).count();
}

/** Najde libovolnou .md cestu (na panel/vim testy). */
export async function findAnyMd(page) {
  return page.evaluate(() => {
    const f = window.__fakan;
    if (!f?.state) return null;
    const nodes = f.state.treeNodes || [];
    const md = nodes.find((n) => n.type === 'file' && /\.md$/i.test(n.name || ''));
    return md?.path ?? null;
  });
}

/** Najde dvě různé .md cesty (pro testy s víc panely). */
export async function findTwoMds(page) {
  return page.evaluate(() => {
    const f = window.__fakan;
    if (!f?.state) return [];
    const nodes = f.state.treeNodes || [];
    const mds = nodes.filter((n) => n.type === 'file' && /\.md$/i.test(n.name || ''));
    return mds.slice(0, 2).map((n) => n.path);
  });
}

/**
 * Registruje listener na console.error a pageerror. Vrací funkci,
 * která hodí, pokud něco neplánovaně padlo.
 */
export function trackConsoleErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // Generický browser log pro 4xx/5xx network response — aplikace ho nemůže potlačit
    // a fetch je obalený v try/catch (např. optional .fokrc soubor). Ne-aplikační noise.
    if (/Failed to load resource/i.test(text)) return;
    errors.push(`console.error: ${text}`);
  });
  return {
    errors,
    expectNone() {
      expect(errors, `nečekané chyby:\n${errors.join('\n')}`).toEqual([]);
    },
  };
}
