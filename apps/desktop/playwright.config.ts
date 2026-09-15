import { defineConfig } from '@playwright/test';

// Exercise the shipped HTML/CSS/JS, not a test-only copy of the workbench.
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  outputDir: './test-results',
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  globalSetup: './tests/setup.mjs',
  use: {
    baseURL: 'http://127.0.0.1:1428',
    browserName: 'chromium',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'scaled', use: { viewport: { width: 1024, height: 720 }, deviceScaleFactor: 1.5 } },
    { name: 'ultrawide', use: { viewport: { width: 3440, height: 1400 } } },
  ],
  webServer: {
    command: 'pnpm exec vite preview --host 127.0.0.1 --port 1428 --strictPort',
    url: 'http://127.0.0.1:1428',
    reuseExistingServer: false,
  },
});
