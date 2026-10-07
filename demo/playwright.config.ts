import { defineConfig, devices } from "@playwright/test";

// Local run: starts Vite against demo/public/demo-data.json (local anvil or Sepolia data).
// Hosted run: DEMO_URL=https://zuemen.github.io/carbon-lei/ npx playwright test
const hosted = process.env.DEMO_URL;
// An uncommon port, and never reuse a server already listening there: another project's dev server on the
// same port would otherwise be tested silently. If the port is taken, the run fails before any test.
const PORT = 5199;
const local = `http://127.0.0.1:${PORT}/carbon-lei/`;

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  retries: hosted ? 1 : 0,
  // The measured runs in the README use one worker.
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: hosted ?? local,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: hosted
    ? undefined
    : {
        command: `npx vite --port ${PORT} --strictPort --host 127.0.0.1`,
        url: local,
        reuseExistingServer: false,
        timeout: 60_000,
      },
});
