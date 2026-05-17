// Badge meta — github + mail linky.
import { test, expect } from '@playwright/test';
import { bootApp } from '../utils/boot.js';
import { SEL } from '../utils/selectors.js';

test.describe('Badge meta', () => {
  test.beforeEach(async ({ page }) => {
    await bootApp(page);
  });

  test('github link vede na junkycoder/fakan a otevírá se v novém tabu', async ({ page }) => {
    const gh = page.locator(`${SEL.badge} a`, { hasText: 'github' });
    await expect(gh).toBeVisible();
    await expect(gh).toHaveAttribute('href', /github\.com\/junkycoder\/fakan/);
    await expect(gh).toHaveAttribute('target', '_blank');
    await expect(gh).toHaveAttribute('rel', /noopener/);
  });

  test('mail link je mailto: na hromada.dan@gmail.com', async ({ page }) => {
    const mail = page.locator(`${SEL.badge} a`, { hasText: 'mail' });
    await expect(mail).toBeVisible();
    await expect(mail).toHaveAttribute('href', /^mailto:hromada\.dan@gmail\.com/);
  });

  test('badge obsahuje obě CTA: "Já to chci taky" a "Přispět"', async ({ page }) => {
    await expect(page.locator('[data-badge-want]')).toBeVisible();
    await expect(page.locator('[data-badge-tip]')).toBeVisible();
  });
});
