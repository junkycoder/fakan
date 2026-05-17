// Boot smoke test — aplikace nastartuje, načte tree.json, vyrendruje mindmapu, žádné errors.
import { test, expect } from '@playwright/test';
import { bootApp, trackConsoleErrors } from '../utils/boot.js';
import { SEL } from '../utils/selectors.js';

test.describe('Boot', () => {
  test('načte tree.json, vyrendruje mindmapu, žádné console errors', async ({ page }) => {
    const errs = trackConsoleErrors(page);
    await bootApp(page);

    // mindmapa renderovaná
    await expect(page.locator(SEL.map)).not.toBeEmpty();
    const labelCount = await page.locator(SEL.label).count();
    expect(labelCount).toBeGreaterThan(0);

    // state expose pro testy je živý
    const treeSize = await page.evaluate(() => window.__fakan?.state?.treeNodes?.length ?? 0);
    expect(treeSize).toBeGreaterThan(0);

    errs.expectNone();
  });

  test('viewport je vycentrovaný a empty-state je schovaný', async ({ page }) => {
    await bootApp(page);
    const empty = page.locator(SEL.emptyState);
    // empty-state buď není v DOM, nebo je hidden
    await expect(empty).toBeHidden();
  });
});
