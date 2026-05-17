// Klávesnicová navigace — šipky napříč kvadranty, focus se přesouvá deterministicky.
import { test, expect } from '@playwright/test';
import { bootApp, focusedPath, currentRootPath, findAnyMd } from '../utils/boot.js';

test.describe('Klávesnicová navigace', () => {
  test.beforeEach(async ({ page }) => {
    await bootApp(page);
  });

  test('šipka dolů z rootu skočí do SOUTH kvadrantu', async ({ page }) => {
    expect(await focusedPath(page)).toBe('');
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => focusedPath(page)).not.toBe('');
    const quadrant = await page.evaluate(() => {
      const f = window.__fakan;
      const n = f.state.byPath.get(f.state.focusedPath);
      return n?.quadrant;
    });
    expect(quadrant).toBe('south');
  });

  test('šipka nahoru z rootu skočí do NORTH kvadrantu', async ({ page }) => {
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => page.evaluate(() => {
      const f = window.__fakan;
      const n = f.state.byPath.get(f.state.focusedPath);
      return n?.quadrant ?? null;
    })).toBe('north');
  });

  test('šipka vlevo / vpravo z rootu skočí do WEST / EAST', async ({ page }) => {
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => page.evaluate(() => window.__fakan.state.byPath.get(window.__fakan.state.focusedPath)?.quadrant ?? null))
      .toBe('east');

    // vrať se k root: 0 vycentruje, ale nesahá na focusedPath
    // proto explicitně přefokusuj root nodem zpět přes byPath
    await page.evaluate(() => {
      const f = window.__fakan;
      f.state.focusedPath = '';
    });

    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => page.evaluate(() => window.__fakan.state.byPath.get(window.__fakan.state.focusedPath)?.quadrant ?? null))
      .toBe('west');
  });

  test('hjkl funguje stejně jako šipky', async ({ page }) => {
    await page.keyboard.press('j'); // down
    await expect.poll(() => focusedPath(page)).not.toBe('');
    const after = await focusedPath(page);
    expect(after).toBeTruthy();
  });

  test('Esc zavře poslední panel (po otevření preview Enterem)', async ({ page }) => {
    const md = await findAnyMd(page);
    test.skip(!md, 'V tree není .md soubor');
    // ručně zaměř .md (Enter na složce dělá recenter, ne openPreview)
    await page.evaluate((p) => { window.__fakan.state.focusedPath = p; }, md);
    await page.keyboard.press('Enter'); // openPreview
    await expect(page.locator('.panel')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.panel')).toHaveCount(0);
  });

  test('0 vycentruje viewport, ale focus nemění', async ({ page }) => {
    await page.keyboard.press('ArrowDown');
    const before = await focusedPath(page);
    expect(before).not.toBe('');
    await page.keyboard.press('0');
    // focusedPath se nemění, jen viewport se přesune
    expect(await focusedPath(page)).toBe(before);
  });

  test('Shift+Enter na složku změní currentRootPath (recenter)', async ({ page }) => {
    // najdi první top-level dir
    const dirPath = await page.evaluate(() => {
      const f = window.__fakan;
      const top = f.state.childrenByPath.get('') || [];
      return top.find((n) => n.type === 'dir')?.path ?? null;
    });
    test.skip(!dirPath, 'V tree není top-level složka');
    // zaměř ji ručně
    await page.evaluate((p) => { window.__fakan.state.focusedPath = p; }, dirPath);
    await page.keyboard.press('Shift+Enter');
    // dir + Enter = recenter (i bez shift), ale tady shift jen potvrdí cestu
    await expect.poll(() => currentRootPath(page)).toBe(dirPath);
  });
});
