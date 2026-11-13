import { defineConfig } from '@playwright/test';

// Browser checks against the dev build (fixture backend). Run: pnpm test:e2e
export default defineConfig({
  testDir: './e2e',
  testMatch: '*.e2e.ts',
  use: { baseURL: 'http://localhost:1420' },
  webServer: { command: 'pnpm dev', url: 'http://localhost:1420', reuseExistingServer: true },
});
