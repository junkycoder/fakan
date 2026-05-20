// Badge meta — řádek odkazů v pravém rohu (help · přispět · github · kontakt).
// „hledat" se přesunul do srcbar pillu vlevo (viz srcbar.spec.js, pokud existuje).
import { test, expect } from '@playwright/test';
import { bootApp } from '../utils/boot.js';
import { SEL } from '../utils/selectors.js';

test.describe('Badge meta', () => {
  test.beforeEach(async ({ page }) => {
    await bootApp(page);
  });

  test('obsahuje meta odkazy ve správném pořadí', async ({ page }) => {
    const labels = await page.locator(`${SEL.badge} a`).allTextContents();
    expect(labels).toEqual(['help', 'přispět', 'github', 'kontakt']);
  });

  test('github link vede na junkycoder/fakan a otevírá se v novém tabu', async ({ page }) => {
    const gh = page.locator(`${SEL.badge} a`, { hasText: 'github' });
    await expect(gh).toBeVisible();
    await expect(gh).toHaveAttribute('href', /github\.com\/junkycoder\/fakan/);
    await expect(gh).toHaveAttribute('target', '_blank');
    await expect(gh).toHaveAttribute('rel', /noopener/);
  });

  test('kontakt otevírá interní dialog (data-badge-contact)', async ({ page }) => {
    const kontakt = page.locator(`${SEL.badge} a`, { hasText: 'kontakt' });
    await expect(kontakt).toBeVisible();
    await expect(kontakt).toHaveAttribute('data-badge-contact', '');
  });

  test('help, přispět, kontakt otevírají interní dialog (href="#")', async ({ page }) => {
    const help = page.locator(`${SEL.badge} a`, { hasText: 'help' });
    const tip = page.locator(`${SEL.badge} a`, { hasText: 'přispět' });
    const kontakt = page.locator(`${SEL.badge} a`, { hasText: 'kontakt' });
    await expect(help).toHaveAttribute('href', '#');
    await expect(tip).toHaveAttribute('href', '#');
    await expect(kontakt).toHaveAttribute('href', '#');
  });

  test('hledat pill je v srcbaru a otevírá search dialog', async ({ page }) => {
    const searchBtn = page.locator('[data-search-btn]');
    await expect(searchBtn).toBeVisible();
    await searchBtn.click();
    await expect(page.locator('[data-search-dialog]')).toBeVisible();
  });
});
