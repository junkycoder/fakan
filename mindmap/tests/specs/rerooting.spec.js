// Re-rooting — Enter/Space na složce změní currentRootPath, ~/ tlačítko vrátí domů.
import { test, expect } from '@playwright/test';
import { bootApp, currentRootPath } from '../utils/boot.js';
import { SEL } from '../utils/selectors.js';

async function findFirstDir(page) {
  return page.evaluate(() => {
    const f = window.__fakan;
    const top = f.state.childrenByPath.get('') || [];
    return top.find((n) => n.type === 'dir')?.path ?? null;
  });
}

test.describe('Re-rooting', () => {
  test.beforeEach(async ({ page }) => {
    await bootApp(page);
  });

  test('Enter na složce změní currentRootPath; ~/ button vrátí domů', async ({ page }) => {
    const dir = await findFirstDir(page);
    test.skip(!dir, 'V tree není top-level složka');

    await page.evaluate((p) => { window.__fakan.state.focusedPath = p; }, dir);
    await page.keyboard.press('Enter');
    await expect.poll(() => currentRootPath(page)).toBe(dir);

    await page.locator(SEL.homeBtn).click();
    await expect.poll(() => currentRootPath(page)).toBe('');
  });

  test('po recenter se mindmapa znovu sestaví (nový treeNodes)', async ({ page }) => {
    const dir = await findFirstDir(page);
    test.skip(!dir, 'V tree není top-level složka');

    const beforeCount = await page.evaluate(() => window.__fakan.state.treeNodes.length);
    await page.evaluate((p) => { window.__fakan.state.focusedPath = p; }, dir);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150); // rebuild je sync, ale CSS transitions ne — počkej
    const afterCount = await page.evaluate(() => window.__fakan.state.treeNodes.length);
    // sub-tree může mít víc nebo míň uzlů; jen ověř, že rebuild proběhl
    expect(afterCount).toBeGreaterThan(0);
    expect(afterCount).not.toBe(beforeCount);
  });
});
