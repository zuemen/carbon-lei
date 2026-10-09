// Prints docs/brief/judge-brief.html to docs/judge-brief.pdf (one A4 page) with Playwright Chromium.
// Usage: node scripts/build-brief.mjs   (needs `npx playwright install chromium` once, and network for Google Fonts)
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "docs/brief/judge-brief.html");
const out = resolve(root, "docs/judge-brief.pdf");

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(src).href, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const missing = await page.evaluate(() =>
    ["600 30px Fraunces", "400 14px 'IBM Plex Mono'"].filter((f) => !document.fonts.check(f)),
  );
  if (missing.length) throw new Error(`fonts not loaded: ${missing.join(", ")}`);
  await page.emulateMedia({ media: "print" });
  await page.pdf({ path: out, format: "A4", printBackground: true, preferCSSPageSize: true });
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
