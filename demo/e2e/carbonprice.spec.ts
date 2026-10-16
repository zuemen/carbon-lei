// The "Carbon price paid (CBAM Art 9)" section (demo/src/tabs/CarbonPrice.tsx), read from carbonprice-data.json, which
// scripts/carbonprice-local.ts builds on a local anvil chain: the draft label comes first, the numbers go from NT$300 ×
// 0.2 to €1.70 per tonne emitted against €82.32 and to 6.709 certificates of 360, the double use is refused, the
// browser's off-chain re-check holds, and axe finds nothing in English or Traditional Chinese.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function scan(page: Page, label: string) {
  await page.evaluate(() => Promise.allSettled(document.getAnimations().map((a) => a.finished)));
  await page.evaluate(() => window.scrollTo(0, 0));
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  const report = violations.map((v) => `${v.impact} ${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(report, `axe on ${label}`).toEqual([]);
}

test("C1 Buyer: the carbon price section says draft first, then local chain, and its numbers are the honest small ones", async ({ page }) => {
  const data = await (await page.request.get("carbonprice-data.json")).json();
  expect(data.mode).toBe("local");
  expect(data.draft).toBe("Draft implementing act, not adopted — illustrative");
  await page.goto("./#buyer");
  const sec = page.locator("#carbon-price");
  await expect(sec.getByText("Carbon price paid (CBAM Art 9)")).toBeVisible();
  const draft = sec.getByTestId("cp-draft");
  await expect(draft).toContainText("Draft implementing act, not adopted — illustrative");
  await expect(draft).toContainText("Ares(2026)4841230");
  await expect(draft).toContainText("no country's carbon price has been recognised");
  // the draft label comes before anything else in the section
  const order = await sec.evaluate((el) => {
    const d = el.querySelector('[data-testid="cp-draft"]')!;
    const h = el.querySelector("h3")!;
    return d.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING;
  });
  expect(order).toBeTruthy();
  await expect(sec.getByTestId("cp-where")).toContainText("on a local anvil chain (chain ID 31337), not on Sepolia");
  await expect(sec.getByRole("heading", { level: 3 })).toHaveText("NT$300 × 0.2 → €1.70 per tonne emitted, against €82.32");
  const rows = sec.locator("table.cp-table tbody tr");
  await expect(rows).toHaveCount(6);
  await expect(rows.nth(1)).toContainText("115,200 t");
  await expect(rows.nth(2)).toContainText("NT$86.4");
  await expect(rows.nth(3)).toContainText("€2.454824");
  await expect(rows.nth(4)).toContainText("€2.761677");
  await expect(rows.nth(5)).toContainText("6.709");
  await expect(sec.getByTestId("cp-of")).toContainText("6.709 of 360 certificates for this shipment: 1.86 %");
  await expect(sec.locator(".pc-result")).toContainText("CARBON_PRICE_WARNING/FX_YEAR");
  await expect(sec.getByText(/Eurostat 2025 annual average/)).toBeVisible();
});

test("C2 Buyer: the certifier's chain, the double use refused, and the browser re-check holds", async ({ page }) => {
  await page.goto("./#buyer");
  const sec = page.locator("#carbon-price");
  await expect(sec.locator("ol.chain > li")).toHaveCount(5);
  await expect(sec.locator(".node-name", { hasText: "Demo Carbon Price Certification GmbH (fictional)" })).toBeVisible();
  await expect(sec.getByText(/CBAM Certification Lead Auditor \(ECR vLEI\)/)).toBeVisible();
  const du = sec.getByTestId("cp-double-use");
  await expect(du).toContainText("reverted with ExceedsVerifiedTonnage");
  await expect(du).toContainText("INVALID (CARBON_PRICE_INVALID/NOT_CLAIMED)");
  await sec.getByRole("button", { name: "Re-check the statement in this browser" }).click();
  const items = sec.locator("ul.pc-items > li");
  await expect(items).toHaveCount(7);
  await expect(sec.locator('ul.pc-items > li[data-ok="false"]')).toHaveCount(0);
  await expect(sec.locator('ul.pc-items > li[data-ok="null"]')).toHaveCount(1);
  await expect(items.nth(5)).toContainText("€2.761677 per t of the declared good");
  await expect(sec.locator(".cp-sources a")).toHaveCount(6);
});

test("C3 axe: no violations in the carbon price section, after the re-check, in English and Traditional Chinese", async ({ page }) => {
  await page.goto("./#buyer");
  const sec = page.locator("#carbon-price");
  await sec.getByRole("button", { name: "Re-check the statement in this browser" }).click();
  await expect(sec.locator("ul.pc-items > li")).toHaveCount(7);
  await scan(page, "Buyer, carbon price section after the re-check");
  await page.goto("./?lang=zh-TW#buyer");
  const zh = page.locator("#carbon-price");
  await expect(zh.getByText("已付碳價（CBAM 第 9 條）")).toBeVisible();
  await expect(zh.getByTestId("cp-draft")).toContainText("執行法草案，尚未通過——僅供示意");
  await expect(zh.getByTestId("cp-where")).toContainText("不在 Sepolia");
  await zh.getByRole("button", { name: "在此瀏覽器重新檢查聲明" }).click();
  await expect(zh.locator("ul.pc-items > li")).toHaveCount(7);
  await scan(page, "Buyer (zh-TW), carbon price section after the re-check");
});
