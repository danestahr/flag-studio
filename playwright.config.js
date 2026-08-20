import { defineConfig } from '@playwright/test';

// Dedicated port so this never collides with a dev server already running
// on Vite's default 5173 (or elsewhere) for this project or another one.
const PORT = 5190;

export default defineConfig({
  testDir: './test',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
