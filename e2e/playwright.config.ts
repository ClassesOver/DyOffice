import { defineConfig } from '@playwright/test'

/** Shared renderer layout checks. No desktop product or Electron launcher. */
export default defineConfig({
  testDir: '.',
  testMatch: [
    'ai-panel-side.spec.ts',
    'docs-header-markup-layout.spec.ts',
    'home-row-menu-layout.spec.ts',
    'home-entry-b-layout.spec.ts',
    'pdf-outline-layout.spec.ts',
    'slides-selection-image.spec.ts',
  ],
  outputDir: './test-results',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  expect: { timeout: 15_000 },
  use: { browserName: 'chromium' },
  reporter: [['list'], ['html', { outputFolder: './playwright-report', open: 'never' }]],
})
