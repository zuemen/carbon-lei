import { defineConfig, devices } from "@playwright/test";

// Local run: starts Vite against demo/public/demo-data.json (local anvil or Sepolia data).
// Hosted run: DEMO_URL=https://zuemen.github.io/carbon-lei/ npx playwright test
const hosted = process.env.DEMO_URL;

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  retries: hosted ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: hosted ?? "http://127.0.0.1:5173/carbon-lei/",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: hosted
    ? undefined
    : {
        command: "npx vite --port 5173 --strictPort --host 127.0.0.1",
        url: "http://127.0.0.1:5173/carbon-lei/",
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
