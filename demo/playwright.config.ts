import { defineConfig, devices } from "@playwright/test";

// Local run: starts Vite against demo/public/demo-data.json (local anvil or Sepolia data).
// Hosted run: DEMO_URL=https://zuemen.github.io/carbon-lei/ npx playwright test
const hosted = process.env.DEMO_URL;
// An uncommon port, and never reuse a server already listening there: another project's dev server on the
// same port would otherwise be tested silently. If the port is taken, the run fails before any test.
const PORT = 5199;
const local = `http://127.0.0.1:${PORT}/carbon-lei/`;

const DEVICES = { chromium: "Desktop Chrome", firefox: "Desktop Firefox", webkit: "Desktop Safari" } as const;
type Browser = keyof typeof DEVICES;
const wanted = (process.env.PW_BROWSERS ?? "chromium").split(",").map((b) => b.trim());
const browsers = (wanted.includes("all") ? Object.keys(DEVICES) : wanted).filter((b): b is Browser => b in DEVICES);
if (!browsers.length) throw new Error(`PW_BROWSERS lists no known browser (chromium, firefox, webkit or all): ${process.env.PW_BROWSERS}`);

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
  // Chromium by default (`npm run e2e`, the counts in the README). Firefox and WebKit are opt-in:
  // PW_BROWSERS=all (or a list such as firefox,webkit) adds their projects; `npm run e2e:all` runs all three.
  projects: browsers.map((name) => ({ name, use: { ...devices[DEVICES[name]] } })),
  webServer: hosted
    ? undefined
    : {
        command: `npx vite --port ${PORT} --strictPort --host 127.0.0.1`,
        url: local,
        reuseExistingServer: false,
        timeout: 60_000,
      },
});
