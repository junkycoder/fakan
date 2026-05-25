import { test, expect } from '@playwright/test';
import { bootApp, findAnyMd, trackConsoleErrors } from '../utils/boot.js';
import { SEL } from '../utils/selectors.js';

async function openFirstMd(page) {
  const md = await findAnyMd(page);
  test.skip(!md, 'mock strom neobsahuje .md');
  // Nastav focusedPath přímo a stiskni Enter na canvasu.
  await page.evaluate((p) => {
    const f = window.__fakan;
    if (f?.state) f.state.focusedPath = p;
  }, md);
  await page.locator(SEL.canvas).focus();
  await page.keyboard.press('Enter');
  // Pro .md default mode je 'rendered' (iframe preview). Přepneme přes play btn na 'source'.
  const playBtn = page.locator(SEL.panelPlay).first();
  await expect(playBtn).toBeVisible({ timeout: 5_000 });
  await playBtn.click();
  await expect(page.locator(SEL.vimMount).first()).toBeVisible({ timeout: 5_000 });
  return md;
}

test.describe('MD editor (vim)', () => {
  test('Enter na .md otevře vim mount v NORMAL', async ({ page }) => {
    const errs = trackConsoleErrors(page);
    await bootApp(page);
    await openFirstMd(page);

    const mode = page.locator('[data-vim-mode]').first();
    await expect(mode).toHaveText(/NORMAL/);
    errs.expectNone();
  });

  test('`i` vstoupí do INSERT, Esc se vrátí do NORMAL', async ({ page }) => {
    await bootApp(page);
    await openFirstMd(page);

    const root = page.locator('.vim').first();
    await root.focus();
    await page.keyboard.press('i');
    await expect(page.locator('[data-vim-mode]').first()).toHaveText(/INSERT/);

    await page.keyboard.press('Escape');
    await expect(page.locator('[data-vim-mode]').first()).toHaveText(/NORMAL/);
  });

  test('Vložení znaku v INSERT mode (běžné písmeno)', async ({ page }) => {
    await bootApp(page);
    await openFirstMd(page);
    const root = page.locator('.vim').first();
    await root.focus();
    await page.keyboard.press('i');
    await page.keyboard.type('AHOJ');

    const buf = page.locator('[data-vim-buf]').first();
    await expect(buf).toContainText('AHOJ');
  });

  test('Option-znaky na CZ klávesnici — Alt + * projde do bufferu (regrese 30a8099)', async ({ page }) => {
    await bootApp(page);
    await openFirstMd(page);
    const root = page.locator('.vim').first();
    await root.focus();
    await page.keyboard.press('i');

    // Simulujeme stisk Option-8 = * na macOS CZ. Playwright `keyboard.press` se
    // synchronizuje na key event s aktivními modifikátory. Použijeme přímo dispatch
    // KeyboardEvent s key='*' a altKey=true — to je přesně to, co browser pošle
    // a aplikace musí přijmout (před fixem 30a8099 to filtroval Alt-guard).
    await page.evaluate(() => {
      const el = document.querySelector('.vim');
      const ev = new KeyboardEvent('keydown', {
        key: '*', code: 'Digit8', altKey: true, bubbles: true, cancelable: true,
      });
      el.dispatchEvent(ev);
    });

    const buf = page.locator('[data-vim-buf]').first();
    await expect(buf).toContainText('*');
  });

  test('Option-# (Alt+3) projde do bufferu', async ({ page }) => {
    await bootApp(page);
    await openFirstMd(page);
    const root = page.locator('.vim').first();
    await root.focus();
    await page.keyboard.press('i');

    await page.evaluate(() => {
      const el = document.querySelector('.vim');
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: '#', code: 'Digit3', altKey: true, bubbles: true, cancelable: true,
      }));
    });

    await expect(page.locator('[data-vim-buf]').first()).toContainText('#');
  });
});
