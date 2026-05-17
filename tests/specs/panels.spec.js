// Panely — Enter otevírá preview, Space toggluje follower, Cmd+Shift+W zavře aktivní,
// [ ] cykluje, M maximalizuje, N otevře preview, 1..9 skok.
import { test, expect } from '@playwright/test';
import { bootApp, findAnyMd, findTwoMds } from '../utils/boot.js';

const isMac = process.platform === 'darwin';
const MOD = isMac ? 'Meta' : 'Control';

async function focusFile(page, path) {
  await page.evaluate((p) => { window.__fakan.state.focusedPath = p; }, path);
}

test.describe('Panely', () => {
  test.beforeEach(async ({ page }) => {
    await bootApp(page);
  });

  test('Enter na souboru otevře preview panel; Enter na jiném souboru přidá další', async ({ page }) => {
    const mds = await findTwoMds(page);
    test.skip(mds.length < 2, 'V tree nejsou aspoň 2 .md soubory');

    await focusFile(page, mds[0]);
    await page.keyboard.press('Enter');
    await expect(page.locator('.panel')).toHaveCount(1);

    await focusFile(page, mds[1]);
    await page.keyboard.press('Enter');
    await expect(page.locator('.panel')).toHaveCount(2);
  });

  test('Enter na stejném souboru nepřidá duplikátní preview (existing → bring to front)', async ({ page }) => {
    const md = await findAnyMd(page);
    test.skip(!md, 'V tree není .md soubor');
    await focusFile(page, md);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(page.locator('.panel')).toHaveCount(1);
  });

  test('Shift+Enter na souboru otevře main (zavře všechny preview)', async ({ page }) => {
    const mds = await findTwoMds(page);
    test.skip(mds.length < 2, 'V tree nejsou aspoň 2 .md soubory');

    await focusFile(page, mds[0]);
    await page.keyboard.press('Enter');
    await focusFile(page, mds[1]);
    await page.keyboard.press('Enter');
    await expect(page.locator('.panel')).toHaveCount(2);

    await page.keyboard.press('Shift+Enter');
    await expect(page.locator('.panel')).toHaveCount(1);
    const hasMain = await page.evaluate(() => !!window.__fakan.state.mainPanel);
    expect(hasMain).toBe(true);
  });

  test('Space otevře follower, druhý Space ho zavře', async ({ page }) => {
    const md = await findAnyMd(page);
    test.skip(!md, 'V tree není .md soubor');
    await focusFile(page, md);
    await page.keyboard.press('Space');
    await expect(page.locator('.panel')).toHaveCount(1);
    const followerPath = await page.evaluate(() => window.__fakan.state.followerPanel?.path ?? null);
    expect(followerPath).toBeTruthy();
    await page.keyboard.press('Space');
    await expect(page.locator('.panel')).toHaveCount(0);
  });

  test(`${MOD}+Shift+W zavře aktivní panel`, async ({ page }) => {
    const md = await findAnyMd(page);
    test.skip(!md, 'V tree není .md soubor');
    await focusFile(page, md);
    await page.keyboard.press('Enter');
    await expect(page.locator('.panel')).toHaveCount(1);
    await page.keyboard.press(`${MOD}+Shift+W`);
    await expect(page.locator('.panel')).toHaveCount(0);
  });

  test(`${MOD}+Shift+M maximalizuje a vrátí`, async ({ page }) => {
    const md = await findAnyMd(page);
    test.skip(!md, 'V tree není .md soubor');
    await focusFile(page, md);
    await page.keyboard.press('Enter');
    const panel = page.locator('.panel').first();
    await expect(panel).toBeVisible();
    await page.keyboard.press(`${MOD}+Shift+M`);
    await expect(panel).toHaveClass(/is-max|panel--max/);
    await page.keyboard.press(`${MOD}+Shift+M`);
    await expect(panel).not.toHaveClass(/is-max|panel--max/);
  });

  test(`${MOD}+Shift+] cykluje aktivní tab dopředu`, async ({ page }) => {
    const mds = await findTwoMds(page);
    test.skip(mds.length < 2, 'V tree nejsou aspoň 2 .md soubory');

    await focusFile(page, mds[0]);
    await page.keyboard.press('Enter');
    await focusFile(page, mds[1]);
    await page.keyboard.press('Enter');
    await expect(page.locator('.panel')).toHaveCount(2);

    const beforeIdx = await page.evaluate(() => {
      const f = window.__fakan;
      const all = Array.from(f.state.previewPanels.values());
      return all.indexOf(f.state.activePanel);
    });
    await page.keyboard.press(`${MOD}+Shift+BracketRight`);
    const afterIdx = await page.evaluate(() => {
      const f = window.__fakan;
      const all = Array.from(f.state.previewPanels.values());
      return all.indexOf(f.state.activePanel);
    });
    expect(afterIdx).not.toBe(beforeIdx);
  });

  test(`${MOD}+Shift+1 skočí na první panel`, async ({ page }) => {
    const mds = await findTwoMds(page);
    test.skip(mds.length < 2, 'V tree nejsou aspoň 2 .md soubory');
    await focusFile(page, mds[0]);
    await page.keyboard.press('Enter');
    await focusFile(page, mds[1]);
    await page.keyboard.press('Enter');
    await page.keyboard.press(`${MOD}+Shift+1`);
    const idx = await page.evaluate(() => {
      const f = window.__fakan;
      const all = [];
      if (f.state.mainPanel) all.push(f.state.mainPanel);
      for (const p of f.state.previewPanels.values()) all.push(p);
      return all.indexOf(f.state.activePanel);
    });
    expect(idx).toBe(0);
  });

  test(`${MOD}+Shift+N otevře preview pro fokus`, async ({ page }) => {
    const md = await findAnyMd(page);
    test.skip(!md, 'V tree není .md soubor');
    await focusFile(page, md);
    await page.keyboard.press(`${MOD}+Shift+N`);
    await expect(page.locator('.panel')).toHaveCount(1);
  });
});
