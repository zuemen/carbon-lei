// Importer workbench tab: line 1 is the demo proof verified live on Sepolia, lines 2–6 illustrative fixtures.
// Expected figures are computed by hand (sdk/test/portfolio.test.ts uses the same inputs):
// CN 7318 from Taiwan 2.707 tCO2e/t; 2026 default with mark-up 2.978, 2027 3.248; price €82.32.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

async function scan(page: Page, label: string) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  await page.evaluate(() => window.scrollTo(0, 0));
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  const report = violations.map((v) => `${v.impact} ${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(report, `axe on ${label}`).toEqual([]);
}

async function openVerified(page: Page, url = "./#importer-workbench") {
  await page.goto(url);
  await expect(page.locator(".wb-live")).toContainText(/verified live at block \d+|已於區塊 \d+ 即時驗證/, { timeout: 60_000 });
}

const rows = (page: Page) => page.locator("table.wb-ledger tbody tr");

test("W1 workbench: line 1 verified live, illustrative lines on defaults with the reason, hand-computed totals", async ({ page }) => {
  await openVerified(page);
  await expect(page.getByRole("tab", { name: "Workbench" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Importer workbench" })).toBeVisible();
  // The seventh tab keeps the desktop tab bar on one row (1280 px).
  const tops = await page.getByRole("tab").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(tops).toHaveLength(7);
  expect(new Set(tops).size, "one row").toBe(1);
  await expect(rows(page)).toHaveCount(6);
  // Line 1, the demo proof: verified 1.8 × 200 t = 360 tCO2e.
  const first = rows(page).nth(0);
  await expect(first).toContainText("BATCH-DEMO-2026-0001");
  await expect(first.locator(".badge")).toHaveText("Valid");
  await expect(first.locator(".wb-basis")).toHaveText("verified");
  await expect(first.locator(".wb-emb")).toHaveText("360");
  // Lines 2–6 are labelled illustrative and each default line says why.
  for (let i = 1; i < 6; i++) await expect(rows(page).nth(i)).toContainText("illustrative");
  await expect(page.locator(".tag-hypo").first()).toHaveText("Illustrative");
  const byId = (id: string) => rows(page).filter({ hasText: id });
  await expect(byId("FNW-2026-014").locator(".wb-emb")).toHaveText("252"); // 120 × 2.1
  await expect(byId("KRC-2026-003").locator(".wb-reason")).toContainText("proof CONTESTED");
  await expect(byId("TWL-2026-021").locator(".wb-reason")).toContainText("proof INVALID (DISCLOSURE_TAMPERED)");
  await expect(byId("HFC-2026-009").locator(".wb-reason")).toContainText("45 t declared but only 40 t claimed on the ledger");
  await expect(byId("TBI-2026-030").locator(".wb-reason")).toContainText("no supplier proof");
  await expect(byId("TBI-2026-030").locator(".wb-emb")).toHaveText("238.24"); // 80 × 2.978
  // Totals: 360 + 252 + 60×2.978 + 35×2.978 + 45×2.978 + 80×2.978 = 612 + 655.16 = 1,267.16 tCO2e;
  // all-default 540 × 2.978 = 1,608.12; gap 340.96; € 1,267.16 × 82.32 = 104,312.61; 1,608.12 × 82.32 = 132,380.44.
  await expect(page.locator(".wb-net")).toHaveText("540 t");
  await expect(page.locator(".wb-embedded")).toHaveText("1,267.16 tCO2e");
  await expect(page.locator(".wb-gap")).toHaveText("340.96 tCO2e");
  await expect(page.locator(".wb-certs")).toHaveText("1,268");
  await expect(page.locator(".wb-eur")).toHaveText("€104,312.61");
  await expect(page.locator(".wb-saved")).toHaveText("€28,067.83");
  await expect(page.getByText("€132,380.44 if every line were on defaults")).toBeVisible();
  // 60 t imported on 14 March already exceeds 50 t.
  await expect(page.locator(".wb-deminimis")).toContainText("exceeded on 2026-03-14 by line KRC-2026-003");
  // 2026 imports: no quarterly holding (it applies from 2027).
  const holding = page.locator("ol.wb-holding > li");
  await expect(holding).toHaveCount(4);
  for (let i = 0; i < 4; i++) await expect(holding.nth(i)).toContainText("not required");

  // 2027 (hypothetical): mark-up 20 % → 3.248; quarterly holding on unmarked 2.707 from the quarter after the crossing (Q1).
  await page.getByRole("radio", { name: /2027 imports/ }).check();
  await expect(byId("TBI-2026-030").locator(".wb-emb")).toHaveText("259.84"); // 80 × 3.248
  await expect(page.locator(".wb-embedded")).toHaveText("1,326.56 tCO2e"); // 612 + 540−200−120 = 220 t × 3.248 = 714.56
  await expect(holding.nth(0)).toContainText("not yet required");
  await expect(holding.nth(1)).toContainText("hold ≥ 244 certificates"); // (162.42 + 324.84) / 2 = 243.63
  await expect(holding.nth(2)).toContainText("hold ≥ 352 certificates"); // + 94.745 + 121.815 → 703.82 / 2 = 351.91
  await expect(holding.nth(3)).toContainText("hold ≥ 731 certificates"); // + 541.4 + 216.56 → 1,461.78 / 2 = 730.89

  // Free-allocation adjustment on default lines, 2026: 1.3299 per t × (60, 35, 45, 80 t) = 79.794 + 46.547 + 59.846 + 106.392.
  await page.getByRole("radio", { name: /2026 imports/ }).check();
  await page.getByRole("checkbox", { name: /free-allocation adjustment/ }).check();
  await expect(page.locator(".wb-adjustment")).toHaveText("292.579 tCO2e");
});

test("W2 workbench CSV: the declaration worksheet with one row per line, labelled not the Registry XML", async ({ page }) => {
  await openVerified(page);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download the declaration worksheet (CSV)" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("carbonlei-worksheet-2026.csv");
  const lines = readFileSync((await file.path())!, "utf8").trimEnd().split("\r\n");
  expect(lines[0]).toContain("not the CBAM Registry XML schema");
  expect(lines[1].split(",").slice(0, 4)).toEqual(["line_id", "cn_code", "country_of_origin", "installation_id"]);
  expect(lines).toHaveLength(2 + 6 + 1);
  expect(lines[2]).toMatch(/^BATCH-DEMO-2026-0001,7318,TW,TW-ZZZZ00TWSCREWDEMO185-0001,Demo Fasteners Co\. \(fictional\),2026-10-10,Q4,200\.000,1\.8,,actual,2\.707,2\.978,360\.000,/);
  expect(lines[2]).toContain("demo proof, verified live on Sepolia");
  expect(lines.slice(3, 8).every((l) => l.includes("illustrative, not on-chain"))).toBe(true);
  expect(lines[8]).toMatch(/^TOTAL,.*,540\.000,.*,1267\.160,,1267\.160$/);
});

test("W3 workbench a11y: axe finds no violations (English and 繁體中文); controls work with the keyboard", async ({ page, browserName }) => {
  await openVerified(page);
  await scan(page, "Importer workbench");
  // Keyboard: Tab to the year radios, arrow to 2027; Space toggles the adjustment; Enter downloads the CSV.
  const r2026 = page.getByRole("radio", { name: /2026 imports/ });
  await r2026.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: /2027 imports/ })).toBeChecked();
  // WebKit on macOS (Safari's default "Press Tab to highlight each item" off) moves to form controls with Option+Tab.
  await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  await expect(page.getByRole("checkbox", { name: /free-allocation adjustment/ })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(page.locator(".wb-adjustment")).toBeVisible();
  const csv = page.getByRole("button", { name: "Download the declaration worksheet (CSV)" });
  await csv.focus();
  const download = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  expect((await download).suggestedFilename()).toBe("carbonlei-worksheet-2027.csv");
  await scan(page, "Importer workbench, 2027 with the adjustment");

  await openVerified(page, "./?lang=zh-TW#importer-workbench");
  await expect(page.getByRole("tab", { name: "進口商工作台" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "進口商工作台" })).toBeVisible();
  await expect(rows(page).filter({ hasText: "HFC-2026-009" }).locator(".wb-reason")).toContainText("申報 45 公噸，但帳本上只申領了 40 公噸");
  await expect(rows(page).filter({ hasText: "TWL-2026-021" }).locator(".wb-reason")).toContainText("證明判定為 INVALID（DISCLOSURE_TAMPERED）");
  await expect(page.getByRole("button", { name: "下載申報工作表（CSV）" })).toBeVisible();
  await expect(page.locator("ol.wb-holding > li").first()).toContainText("2026 年進口不適用");
  await scan(page, "進口商工作台");
});

test("W4 workbench on a 390 px phone: no sideways scroll, each line a card, tab reachable in the one-row tab bar", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openVerified(page);
  await expect(page.getByRole("tab", { name: "Workbench" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const tableOverflow = await page.locator(".workbench .table-wrap").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(tableOverflow).toBeLessThanOrEqual(0);
  expect(await rows(page).first().evaluate((el) => getComputedStyle(el).display)).toBe("block");
  for (const name of [/2026 imports/, /2027 imports/]) {
    const b = (await page.getByRole("radio", { name }).locator("xpath=..").boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(44);
  }
});
