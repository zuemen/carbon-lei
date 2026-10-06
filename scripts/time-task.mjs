// Scripted task timing on the hosted page: open the page -> "Load the demo proof" -> "Verify" -> "8 of 8" visible.
// A script, not a user: it clicks as soon as each button is ready and reads nothing.
// Usage: npx playwright install chromium && node scripts/time-task.mjs [url] [runs]
import { chromium } from "@playwright/test";

const url = process.argv[2] ?? "https://zuemen.github.io/carbon-lei/";
const n = Number(process.argv[3] ?? 5);
const browser = await chromium.launch();
const runs = [];
for (let i = 0; i < n; i++) {
  const context = await browser.newContext(); // fresh context per run: empty cache
  const page = await context.newPage();
  let clicks = 0;
  const t0 = performance.now();
  await page.goto(url);
  await page.getByRole("button", { name: "Load the demo proof" }).click();
  clicks++;
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  clicks++;
  await page.getByText(/8 of 8/).first().waitFor({ timeout: 60_000 });
  runs.push({ run: i + 1, clicks, seconds: Number(((performance.now() - t0) / 1000).toFixed(2)) });
  await context.close();
}
await browser.close();
const sorted = runs.map((r) => r.seconds).sort((a, b) => a - b);
const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
console.log(JSON.stringify({ url, at: new Date().toISOString(), runs, median, min: sorted[0], max: sorted[n - 1] }, null, 2));
