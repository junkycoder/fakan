// Badge meta — řádek odkazů v rohu (přispět · odebírat · github · email · podmínky · licence).
import { test, expect } from '@playwright/test';
import { bootApp } from '../utils/boot.js';
import { SEL } from '../utils/selectors.js';

test.describe('Badge meta', () => {
  test.beforeEach(async ({ page }) => {
    await bootApp(page);
  });

  test('obsahuje všechny meta odkazy ve správném pořadí', async ({ page }) => {
    const labels = await page.locator(`${SEL.badge} a`).allTextContents();
    expect(labels).toEqual(['přispět', 'odebírat', 'github', 'email', 'podmínky', 'licence']);
  });

  test('github link vede na junkycoder/fakan a otevírá se v novém tabu', async ({ page }) => {
    const gh = page.locator(`${SEL.badge} a`, { hasText: 'github' });
    await expect(gh).toBeVisible();
    await expect(gh).toHaveAttribute('href', /github\.com\/junkycoder\/fakan/);
    await expect(gh).toHaveAttribute('target', '_blank');
    await expect(gh).toHaveAttribute('rel', /noopener/);
  });

  test('email link je mailto: na hromada.dan@gmail.com', async ({ page }) => {
    const mail = page.locator(`${SEL.badge} a`, { hasText: 'email' });
    await expect(mail).toBeVisible();
    await expect(mail).toHaveAttribute('href', /^mailto:hromada\.dan@gmail\.com/);
  });

  test('odebírat je mailto: s předmětem Odebírat', async ({ page }) => {
    const sub = page.locator(`${SEL.badge} a`, { hasText: 'odebírat' });
    await expect(sub).toBeVisible();
    await expect(sub).toHaveAttribute('href', /^mailto:hromada\.dan@gmail\.com.*Odeb/i);
  });

  test('licence vede na AGPL-3.0', async ({ page }) => {
    const lic = page.locator(`${SEL.badge} a`, { hasText: 'licence' });
    await expect(lic).toHaveAttribute('href', /gnu\.org\/licenses\/agpl-3\.0/);
  });
});
