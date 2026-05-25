// QR Platba dialog — Přispět button v badge → dialog s QR a IBAN.
import { test, expect } from '@playwright/test';
import { bootApp } from '../utils/boot.js';
import { SEL } from '../utils/selectors.js';

test.describe('QR Platba dialog', () => {
  test.beforeEach(async ({ page }) => {
    await bootApp(page);
  });

  test('klik na Přispět otevře dialog s QR a IBAN', async ({ page }) => {
    const tipBtn = page.locator(SEL.badgeTipBtn);
    // badge je hidden v základu, ale obsah uvnitř může existovat — počkej, až je
    // tlačítko v DOM (mountBadge() je sync v boot.js)
    await expect(tipBtn).toBeVisible();
    await tipBtn.click();

    const dialog = page.locator(SEL.tipDialog);
    await expect(dialog).toBeVisible();
    // role="dialog" je na vnitřním panelu, ne na wrapu
    await expect(dialog.locator('[role="dialog"]')).toBeVisible();

    // QR vyrendrovaný (qrcode.js vytvoří <table> nebo <canvas>)
    const qr = page.locator(SEL.tipQr);
    const qrChildCount = await qr.locator('*').count();
    expect(qrChildCount).toBeGreaterThan(0);

    // IBAN v textu (CZ15 3030 …)
    await expect(dialog).toContainText(/CZ\d{2}/);
  });

  test('Copy zkopíruje číslo účtu do schránky', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'Clipboard API stabilní jen v chromium');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await page.locator(SEL.badgeTipBtn).click();
    const accountText = (await page.locator(SEL.tipAccount).textContent())?.trim() ?? '';
    expect(accountText).toBeTruthy();

    await page.locator(SEL.tipCopyBtn).click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    // může obsahovat formátování — porovnáme alphanumerics
    expect(clip.replace(/\s+/g, '')).toContain(accountText.replace(/\s+/g, '').split('/')[0]);
  });

  test('Close button zavře dialog', async ({ page }) => {
    await page.locator(SEL.badgeTipBtn).click();
    await expect(page.locator(SEL.tipDialog)).toBeVisible();
    await page.locator(SEL.tipCloseBtn).click();
    await expect(page.locator(SEL.tipDialog)).toHaveCount(0);
  });
});
