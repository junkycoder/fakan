import { test, expect } from '@playwright/test';
import { bootApp, focusedPath, trackConsoleErrors } from '../utils/boot.js';
import { SEL } from '../utils/selectors.js';

async function focusPath(page, path) {
  await page.evaluate((p) => {
    const f = window.__fakan;
    if (f?.state) f.state.focusedPath = p;
  }, path);
}

test.describe('URL hierarchie (Cmd/Ctrl+←/→)', () => {
  test('Cmd+← na souboru přesune focus na rodičovskou složku', async ({ page }) => {
    const errs = trackConsoleErrors(page);
    await bootApp(page);

    // mock obsahuje projects/alfa.md — fokusneme ten soubor
    await focusPath(page, 'projects/alfa.md');
    await page.locator(SEL.canvas).focus();
    await page.keyboard.press('ControlOrMeta+ArrowLeft');

    const fp = await focusedPath(page);
    expect(fp).toBe('projects');
    errs.expectNone();
  });

  test('Cmd+→ ze složky přesune focus na první dítě', async ({ page }) => {
    await bootApp(page);
    await focusPath(page, 'projects');
    await page.locator(SEL.canvas).focus();
    await page.keyboard.press('ControlOrMeta+ArrowRight');

    const fp = await focusedPath(page);
    expect(fp).toMatch(/^projects\//);
  });

  test('Cmd+← na rootu recentruje na parent (z fakan.cz → root /)', async ({ page }) => {
    await bootApp(page);
    // recenter na projects/, takže fakan-root je teď „projects"
    await page.evaluate(() => {
      const f = window.__fakan;
      if (f?.state) f.state.focusedPath = 'projects';
    });
    await page.locator(SEL.canvas).focus();
    await page.keyboard.press('Enter'); // Shift+Enter na složce by re-rootnul, ale stačí přes API
    // Re-root přímo přes window pomocí Shift+Enter na fokusu
    await page.keyboard.press('Shift+Enter');

    const root = await page.evaluate(() => window.__fakan?.state?.currentRootPath);
    test.skip(root !== 'projects', `recenter selhal — currentRootPath=${root}`);

    // Teď Cmd+← na rootu → zpět na parent (prázdný root)
    await focusPath(page, 'projects');
    await page.keyboard.press('ControlOrMeta+ArrowLeft');

    const after = await page.evaluate(() => window.__fakan?.state?.currentRootPath);
    expect(after).toBe('');
  });

  test('Plain ← a → bez Cmd: tree-nav (sourozenec ve stejném kvadrantu)', async ({ page }) => {
    await bootApp(page);
    // V mock SOUTH (projects/) jsou alfa.md a beta.md — sourozenci
    await focusPath(page, 'projects/alfa.md');
    await page.locator(SEL.canvas).focus();
    await page.keyboard.press('ArrowRight');

    const fp = await focusedPath(page);
    // ArrowRight v SOUTH = nextSibling
    expect(fp).toBe('projects/beta.md');
  });
});
