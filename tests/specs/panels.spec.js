// Panely — po commitu 7432e1f platí:
//   Enter         → openMain (vždy 1 main panel, nahrazuje předchozí)
//   Shift+Enter   → openMainOnly (zavře preview/follower + main)
//   Space         → openAsFollower (toggle close na stejném uzlu)
//   Cmd+Shift+W   → close active
//   Cmd+Shift+M   → toggle maximize
//   Cmd+Shift+N   → openAsFollower (sleduje focus)
//   Cmd+Shift+[ ] → cyklus tabů (main + follower)
//   Cmd+Shift+1–9 → skok na n-tý panel
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

  test('Enter na souboru otevře main; Enter na jiném souboru main nahradí', async ({ page }) => {
    const mds = await findTwoMds(page);
    test.skip(mds.length < 2, 'V tree nejsou aspoň 2 .md soubory');

    await focusFile(page, mds[0]);
    await page.keyboard.press('Enter');
    await expect(page.locator('.panel')).toHaveCount(1);
    let main = await page.evaluate(() => window.__fakan.state.mainPanel?.path);
    expect(main).toBe(mds[0]);

    await focusFile(page, mds[1]);
    await page.keyboard.press('Enter');
    await expect(page.locator('.panel')).toHaveCount(1);
    main = await page.evaluate(() => window.__fakan.state.mainPanel?.path);
    expect(main).toBe(mds[1]);
  });

  test('Space + Enter dá 2 panely (follower + main)', async ({ page }) => {
    const mds = await findTwoMds(page);
    test.skip(mds.length < 2, 'V tree nejsou aspoň 2 .md soubory');

    await focusFile(page, mds[0]);
    await page.keyboard.press('Space'); // follower
    await expect(page.locator('.panel')).toHaveCount(1);

    await focusFile(page, mds[1]);
    await page.keyboard.press('Enter'); // main
    await expect(page.locator('.panel')).toHaveCount(2);

    const snap = await page.evaluate(() => ({
      hasMain: !!window.__fakan.state.mainPanel,
      hasFollower: !!window.__fakan.state.followerPanel,
    }));
    expect(snap.hasMain).toBe(true);
    expect(snap.hasFollower).toBe(true);
  });

  test('Shift+Enter zavře follower a otevře jediný main', async ({ page }) => {
    const mds = await findTwoMds(page);
    test.skip(mds.length < 2, 'V tree nejsou aspoň 2 .md soubory');

    await focusFile(page, mds[0]);
    await page.keyboard.press('Space');
    await focusFile(page, mds[1]);
    await page.keyboard.press('Enter');
    await expect(page.locator('.panel')).toHaveCount(2);

    await page.keyboard.press('Shift+Enter');
    await expect(page.locator('.panel')).toHaveCount(1);
    const hasMain = await page.evaluate(() => !!window.__fakan.state.mainPanel);
    const hasFollower = await page.evaluate(() => !!window.__fakan.state.followerPanel);
    expect(hasMain).toBe(true);
    expect(hasFollower).toBe(false);
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

  test(`${MOD}+Shift+] cykluje mezi main a follower`, async ({ page }) => {
    const mds = await findTwoMds(page);
    test.skip(mds.length < 2, 'V tree nejsou aspoň 2 .md soubory');

    await focusFile(page, mds[0]);
    await page.keyboard.press('Space');
    await focusFile(page, mds[1]);
    await page.keyboard.press('Enter');
    await expect(page.locator('.panel')).toHaveCount(2);

    const beforePath = await page.evaluate(() => window.__fakan.state.activePanel?.path ?? null);
    await page.keyboard.press(`${MOD}+Shift+BracketRight`);
    const afterPath = await page.evaluate(() => window.__fakan.state.activePanel?.path ?? null);
    expect(afterPath).not.toBe(beforePath);
  });

  test(`${MOD}+Shift+1 skočí na první panel`, async ({ page }) => {
    const mds = await findTwoMds(page);
    test.skip(mds.length < 2, 'V tree nejsou aspoň 2 .md soubory');
    await focusFile(page, mds[0]);
    await page.keyboard.press('Space');
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

  test(`${MOD}+Shift+N otevře follower pro fokus`, async ({ page }) => {
    const md = await findAnyMd(page);
    test.skip(!md, 'V tree není .md soubor');
    await focusFile(page, md);
    await page.keyboard.press(`${MOD}+Shift+N`);
    await expect(page.locator('.panel')).toHaveCount(1);
    const hasFollower = await page.evaluate(() => !!window.__fakan.state.followerPanel);
    expect(hasFollower).toBe(true);
  });
});
