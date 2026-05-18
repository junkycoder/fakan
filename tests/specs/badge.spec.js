// Badge meta — řádek odkazů v rohu (přispět · odebírat · github · email · podmínky · licence).
import { test, expect } from '@playwright/test';
import { bootApp } from '../utils/boot.js';
import { SEL } from '../utils/selectors.js';

test.describe('Badge meta', () => {
  test.beforeEach(async ({ page }) => {
    await bootApp(page);
  });

  test('obsahuje meta odkazy ve správném pořadí', async ({ page }) => {
    const labels = await page.locator(`${SEL.badge} a`).allTextContents();
    expect(labels).toEqual(['hledat', 'help', 'přispět', 'github', 'kontakt']);
  });

  test('github link vede na junkycoder/fakan a otevírá se v novém tabu', async ({ page }) => {
    const gh = page.locator(`${SEL.badge} a`, { hasText: 'github' });
    await expect(gh).toBeVisible();
    await expect(gh).toHaveAttribute('href', /github\.com\/junkycoder\/fakan/);
    await expect(gh).toHaveAttribute('target', '_blank');
    await expect(gh).toHaveAttribute('rel', /noopener/);
  });

  test('kontakt je mailto: na hromada.dan@gmail.com', async ({ page }) => {
    const mail = page.locator(`${SEL.badge} a`, { hasText: 'kontakt' });
    await expect(mail).toBeVisible();
    await expect(mail).toHaveAttribute('href', /^mailto:hromada\.dan@gmail\.com/);
  });

  test('help a přispět otevírají interní dialog (href="#")', async ({ page }) => {
    const help = page.locator(`${SEL.badge} a`, { hasText: 'help' });
    const tip = page.locator(`${SEL.badge} a`, { hasText: 'přispět' });
    await expect(help).toHaveAttribute('href', '#');
    await expect(tip).toHaveAttribute('href', '#');
  });
});
