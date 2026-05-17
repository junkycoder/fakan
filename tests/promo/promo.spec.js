// Promo screenshoty — deterministické snímky pro demo/marketing/README.
// Spouštět přes `npm run promo`. Výstup do tests/screenshots/.
import { test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, findAnyMd } from '../utils/boot.js';
import { SEL } from '../utils/selectors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(__dirname, '..', 'screenshots');

function shotPath(name, project) {
  const suffix = project === 'chromium-dark' ? '-dark' : project === 'mobile' ? '-mobile' : '-light';
  return path.join(SHOTS, `${name}${suffix}.png`);
}

test.describe('Promo screenshoty', () => {
  test('01 home — celá mindmapa', async ({ page }, testInfo) => {
    await bootApp(page);
    await page.waitForTimeout(300); // CSS animace dojezd
    await page.screenshot({
      path: shotPath('01-home', testInfo.project.name),
      fullPage: false,
    });
  });

  test('02 preview panel — otevřený .md', async ({ page }, testInfo) => {
    await bootApp(page);
    const md = await findAnyMd(page);
    test.skip(!md, 'V tree není .md soubor');
    await page.evaluate((p) => { window.__fakan.state.focusedPath = p; }, md);
    await page.keyboard.press('Enter');
    await page.waitForSelector(SEL.panel);
    await page.waitForTimeout(400);
    await page.screenshot({
      path: shotPath('02-panel-md', testInfo.project.name),
    });
  });

  test('03 QR Platba dialog', async ({ page }, testInfo) => {
    await bootApp(page);
    await page.locator(SEL.badgeTipBtn).click();
    await page.waitForSelector(SEL.tipDialog);
    await page.waitForTimeout(300); // QR render
    await page.screenshot({
      path: shotPath('03-qr-dialog', testInfo.project.name),
    });
  });

  test('04 vim follower — Space na souboru', async ({ page }, testInfo) => {
    await bootApp(page);
    const md = await findAnyMd(page);
    test.skip(!md, 'V tree není .md soubor');
    await page.evaluate((p) => { window.__fakan.state.focusedPath = p; }, md);
    await page.keyboard.press('Space');
    await page.waitForSelector(SEL.panel);
    await page.waitForTimeout(400);
    await page.screenshot({
      path: shotPath('04-vim-follower', testInfo.project.name),
    });
  });

  test('05 source menu rozkliknutý', async ({ page }, testInfo) => {
    await bootApp(page);
    await page.locator(SEL.sourceBtn).click();
    await page.waitForTimeout(150);
    await page.screenshot({
      path: shotPath('05-source-menu', testInfo.project.name),
    });
  });
});
