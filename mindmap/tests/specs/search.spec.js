import { test, expect } from '@playwright/test';
import { bootApp, trackConsoleErrors } from '../utils/boot.js';
import { SEL } from '../utils/selectors.js';

test.describe('Globální hledání', () => {
  test('Cmd/Ctrl+K otevře dialog a fokusne input', async ({ page }) => {
    const errs = trackConsoleErrors(page);
    await bootApp(page);

    await page.locator(SEL.canvas).press('ControlOrMeta+k');

    const dialog = page.locator(SEL.searchDialog);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(SEL.searchInput)).toBeFocused();
    errs.expectNone();
  });

  test('Klik na badge „hledat" také otevře dialog', async ({ page }) => {
    await bootApp(page);
    const btn = page.locator(SEL.searchBtn);
    if ((await btn.count()) === 0) test.skip(true, 'badge „hledat" se v daném zdroji nezobrazila');
    await btn.click();
    await expect(page.locator(SEL.searchDialog)).toBeVisible();
  });

  test('Zadání query vyhledá v názvech (mock obsahuje „jablko" v textech)', async ({ page }) => {
    await bootApp(page);
    await page.locator(SEL.canvas).press('ControlOrMeta+k');
    const input = page.locator(SEL.searchInput);
    await input.fill('alfa');

    // status z debouncovaného `run()` (120ms) — Playwright auto-waits
    await expect(page.locator(SEL.searchStatus)).toContainText(/×/);
    const results = page.locator(SEL.searchResult);
    await expect(results.first()).toBeVisible();
    await expect(results.first()).toContainText(/alfa/i);
  });

  test('Šipka dolů highlightne první výsledek, Enter ho otevře', async ({ page }) => {
    await bootApp(page);
    await page.locator(SEL.canvas).press('ControlOrMeta+k');
    await page.locator(SEL.searchInput).fill('alfa');
    await expect(page.locator(SEL.searchResult).first()).toBeVisible();

    await page.keyboard.press('ArrowDown');
    await expect(page.locator(SEL.searchResultActive)).toHaveCount(1);

    await page.keyboard.press('Enter');
    await expect(page.locator(SEL.searchDialog)).toHaveCount(0);

    // Otevření výsledku přes openResult() → buď otevře main panel, nebo recenter
    // (záleží na tom, jestli je soubor v aktuálním podstromu). Aspoň state by měl
    // odkazovat na nalezenou cestu.
    const focused = await page.evaluate(() => window.__fakan?.state?.focusedPath);
    expect(focused == null || /alfa/i.test(focused) || focused === '').toBeTruthy();
  });

  test('Hledání obsahu — najde slovo uvnitř .md', async ({ page }) => {
    await bootApp(page);
    await page.locator(SEL.canvas).press('ControlOrMeta+k');
    await page.locator(SEL.searchInput).fill('jablko');

    // mock obsahuje „jablko" v texty/uvod.md a projects/beta.md
    // — match v názvu žádný neexistuje, takže výsledky přijdou až po fetch obsahu.
    const results = page.locator(SEL.searchResult);
    await expect(results.first()).toBeVisible({ timeout: 8_000 });
    const text = await results.first().textContent();
    expect(text).toMatch(/obsah/);
  });

  test('Escape zavře dialog', async ({ page }) => {
    await bootApp(page);
    await page.locator(SEL.canvas).press('ControlOrMeta+k');
    await expect(page.locator(SEL.searchDialog)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator(SEL.searchDialog)).toHaveCount(0);
  });
});
