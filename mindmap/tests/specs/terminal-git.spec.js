import { test, expect } from '@playwright/test';
import { bootApp, trackConsoleErrors } from '../utils/boot.js';
import { SEL } from '../utils/selectors.js';

async function openTerminalAndType(page, cmd) {
  await page.locator(SEL.canvas).press('ControlOrMeta+t');
  const input = page.locator(SEL.termInput).last();
  await expect(input).toBeVisible();
  await input.click();
  await input.fill(cmd);
  await input.press('Enter');
}

test.describe('Terminál — git builtin', () => {
  test('Cmd/Ctrl+T otevře terminál s uvítací zprávou a promptem', async ({ page }) => {
    const errs = trackConsoleErrors(page);
    await bootApp(page);
    await page.locator(SEL.canvas).press('ControlOrMeta+t');

    const mount = page.locator(SEL.termMount).last();
    await expect(mount).toBeVisible();
    await expect(mount.locator(SEL.termPrompt)).toContainText('$');
    await expect(mount.locator(SEL.termScroll)).toContainText(/fakan terminál/);
    errs.expectNone();
  });

  test('`help` vypíše seznam příkazů', async ({ page }) => {
    await bootApp(page);
    await openTerminalAndType(page, 'help');
    const scroll = page.locator(SEL.termScroll).last();
    // help vrací aspoň jeden řádek se slovem „git" nebo „cd" — toleruj formát
    await expect(scroll).toContainText(/git|cd|ls|help/i);
  });

  test('`git status` zobrazí větev a remote (mock GitHub)', async ({ page }) => {
    await bootApp(page);
    await openTerminalAndType(page, 'git status');

    const scroll = page.locator(SEL.termScroll).last();
    await expect(scroll).toContainText(/Na větvi main/);
    await expect(scroll).toContainText(/junkycoder\/fakan\.cz/);
  });

  test('`git log` vypíše commity (mock vrací 2)', async ({ page }) => {
    await bootApp(page);
    await openTerminalAndType(page, 'git log');

    const scroll = page.locator(SEL.termScroll).last();
    await expect(scroll).toContainText(/mock: initial commit/);
    await expect(scroll).toContainText(/mock: druhý commit/);
  });

  test('`git neznamy` vrátí chybu na stderr', async ({ page }) => {
    await bootApp(page);
    await openTerminalAndType(page, 'git foobar');

    const scroll = page.locator(SEL.termScroll).last();
    await expect(scroll).toContainText(/neznámý subcommand/);
  });

  test('History — šipka nahoru vrátí předchozí příkaz', async ({ page }) => {
    await bootApp(page);
    await openTerminalAndType(page, 'help');
    const input = page.locator(SEL.termInput).last();
    await input.press('ArrowUp');
    await expect(input).toHaveValue('help');
  });
});
