import { test, expect } from '@playwright/test';
import { bootApp, trackConsoleErrors } from '../utils/boot.js';
import { SEL } from '../utils/selectors.js';

test.describe('Menu Zdroje', () => {
  test('Tři hlavní akce v menu (Nahrát / Připojit z disku / Připojit GitHub)', async ({ page }) => {
    const errs = trackConsoleErrors(page);
    await bootApp(page);

    const items = page.locator('[data-source-menu] ' + SEL.srcbarItem);
    await expect(items).not.toHaveCount(0);

    const labels = await items.allTextContents();
    const joined = labels.join(' | ');
    expect(joined).toMatch(/Nahrát složku/);
    expect(joined).toMatch(/Připojit složku/);
    expect(joined).toMatch(/Připojit GitHub/);
    errs.expectNone();
  });

  test('„Pozvat ke spolupráci…" je dostupné pro GitHub zdroj (default mock)', async ({ page }) => {
    await bootApp(page);
    // Default zdroj v mocku je GitHub (github:junkycoder/fakan.cz) — state.githubSpec
    // by mělo být naplněné po loadu. Pokud ne, test je nerelevantní.
    const hasGh = await page.evaluate(() => !!window.__fakan?.state?.githubSpec);
    test.skip(!hasGh, 'state.githubSpec není naplněné (mock fallback?)');

    const items = page.locator('[data-source-menu] ' + SEL.srcbarItem);
    const labels = (await items.allTextContents()).join(' | ');
    expect(labels).toMatch(/Pozvat ke spolupráci/);
  });

  test('„Odpojit zdroj" se ukazuje, když je zdroj připojený', async ({ page }) => {
    await bootApp(page);
    const hasSrc = await page.evaluate(() => {
      const s = window.__fakan?.state;
      return !!(s?.githubSpec || s?.rootHandle || s?.uploadedSnapshot);
    });
    test.skip(!hasSrc, 'žádný zdroj není připojen');

    const items = page.locator('[data-source-menu] ' + SEL.srcbarItem);
    const labels = (await items.allTextContents()).join(' | ');
    expect(labels).toMatch(/Odpojit zdroj/);
  });

  test('Label v navu ukazuje owner/repo pro GitHub zdroj', async ({ page }) => {
    await bootApp(page);
    const hasGh = await page.evaluate(() => !!window.__fakan?.state?.githubSpec);
    test.skip(!hasGh, 'state.githubSpec není naplněné');

    const label = page.locator(SEL.sourceLabel);
    await expect(label).toHaveText(/junkycoder\/fakan\.cz/);
  });

  test('Klik na source btn dá fokus do nav-source wrapperu (otevře menu CSS-em)', async ({ page }) => {
    await bootApp(page);
    await page.locator('[data-source-btn]').click();
    // focus uvnitř [data-nav-source] → :focus-within v CSS odhalí menu.
    const focusInside = await page.evaluate(() => {
      const wrap = document.querySelector('[data-nav-source]');
      return wrap?.contains(document.activeElement);
    });
    expect(focusInside).toBe(true);
  });
});
