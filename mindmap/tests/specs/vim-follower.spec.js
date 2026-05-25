// Vim editor ve Space-followeru — focus zůstává na mindmapě, šipky řídí navigaci, ne editor.
// Regrese commitu 609523b.
import { test, expect } from '@playwright/test';
import { bootApp, findAnyMd, focusedPath } from '../utils/boot.js';
import { SEL } from '../utils/selectors.js';

test.describe('Vim follower focus', () => {
  test.beforeEach(async ({ page }) => {
    await bootApp(page);
  });

  test('Space otevře follower s vim mountem, šipka stále řídí mindmapu', async ({ page }) => {
    const md = await findAnyMd(page);
    test.skip(!md, 'V tree není .md soubor');

    // zaměř MD soubor a otevři jako follower
    await page.evaluate((p) => { window.__fakan.state.focusedPath = p; }, md);
    await page.keyboard.press('Space');
    await expect(page.locator(SEL.panel)).toHaveCount(1);

    // vim mount existuje uvnitř panelu (.md soubory ho dostávají v rendered módu)
    // ale aktivní element musí zůstat mimo editor (mindmap canvas nebo body)
    const active = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      return { tag: el.tagName, isVim: !!el.closest('.vim') };
    });
    expect(active?.isVim).toBeFalsy();

    // šipka — focus na mindmapě se musí pohnout (followerPanel se sám přesune za novým focusem)
    const before = await focusedPath(page);
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => focusedPath(page)).not.toBe(before);

    // follower stále existuje a sleduje nový focus
    const followerPath = await page.evaluate(() => window.__fakan.state.followerPanel?.path ?? null);
    expect(followerPath).toBeTruthy();
  });
});
