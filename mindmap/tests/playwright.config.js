import { defineConfig, devices } from '@playwright/test';

// Lokální preview server identický s `.claude/launch.json` — python3 -m http.server 5173.
// Pokud už běží (preview MCP), reuse-uje se.
// FAKAN_TEST_PORT env override umožňuje cílit na preview konkrétního worktree,
// když paralelní session drží defaultní 5173.
const PORT = Number(process.env.FAKAN_TEST_PORT) || 5173;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: '.',
  testMatch: ['specs/**/*.spec.js', 'promo/**/*.spec.js'],

  fullyParallel: false, // mindmap test setup je single-tab; serial je čitelnější
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,

  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],

  use: {
    baseURL: BASE_URL,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2, // ostré screenshoty pro promo materiály
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  // Visual regression tolerance: mindmap je monospace grid, font hinting se napříč OS liší.
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02,
      threshold: 0.2,
    },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], colorScheme: 'light' },
    },
    {
      name: 'chromium-dark',
      use: { ...devices['Desktop Chrome'], colorScheme: 'dark' },
      testMatch: ['promo/**/*.spec.js'],
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 5'] },
      testMatch: ['promo/**/*.spec.js'],
    },
  ],

  webServer: {
    command: `python3 -m http.server ${PORT}`,
    cwd: '..',
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 15_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
