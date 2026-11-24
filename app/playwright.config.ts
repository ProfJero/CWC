import { defineConfig } from '@playwright/test';

/**
 * Browser end-to-end tests. They run the production build (vite preview, port 4173) against the
 * Supabase project in .env.production, signing in as dedicated "E2E Test" accounts whose password
 * is passed in E2E_PASSWORD. See README → Testing.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4173',
    trace: 'off',
    serviceWorkers: 'block',
  },
  webServer: process.env.E2E_BASE_URL ? undefined : { command: 'npx vite preview --host 127.0.0.1 --port 4173 --strictPort', port: 4173, reuseExistingServer: true },
});
