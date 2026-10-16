// The "Precursor (wire rod)" sections (demo/src/tabs/Precursor.tsx), read from precursor-data.json, which
// scripts/precursor-local.ts builds on a local anvil chain: each section says so, the breakdown adds up to the
// signed 1.8, the browser's off-chain re-check holds, card 5 shows the cap one tier up, and axe finds nothing in
// English or Traditional Chinese.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function scan(page: Page, label: string) {
  await page.evaluate(() => Promise.allSettled(document.getAnimations().map((a) => a.finished)));
  await page.evaluate(() => window.scrollTo(0, 0));
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  const report = violations.map((v) => `${v.impact} ${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(report, `axe on ${label}`).toEqual([]);
}

test("P1 Buyer: the precursor section is labelled local chain, its breakdown gives the signed 1.8, and the browser re-check holds", async ({ page }) => {
  const data = await (await page.request.get("precursor-data.json")).json();
  expect(data.mode).toBe("local");
  expect(data.chainId).toBe(31337);
  await page.goto("./#buyer");
  const sec = page.locator("#precursor");
  await expect(sec.getByText("Precursor (wire rod)")).toBeVisible();
  await expect(sec.getByTestId("precursor-where")).toContainText("on a local anvil chain (chain ID 31337), not on Sepolia");
  await expect(sec.getByTestId("precursor-where")).toContainText("synthetic");
  const rows = sec.locator("table.pc-table tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("0.18");
  await expect(rows.nth(1)).toContainText("1.125 t/t × 1.44 tCO2e/t");
  await expect(rows.nth(1)).toContainText("1.62");
  await expect(rows.nth(1)).toContainText("90%");
  await expect(rows.nth(2)).toContainText("1.8");
  await expect(sec.getByText(/562\.5 t claimed for the screw maker/)).toBeVisible();
  await expect(sec.locator(".pc-result code")).toHaveCount(0); // check 9 passed: no code
  await sec.getByRole("button", { name: "Re-check the off-chain parts in this browser" }).click();
  const items = sec.locator("ul.pc-items > li");
  await expect(items).toHaveCount(8);
  await expect(sec.locator('ul.pc-items > li[data-ok="false"]')).toHaveCount(0);
  await expect(sec.locator('ul.pc-items > li[data-ok="null"]')).toHaveCount(1); // the on-chain facts: not re-read
  await expect(items.last()).toContainText("0.18 + 1.62 = 1.8 tCO2e/t recomputed, 1.8 declared");
});

test("P2 Trust chain: the mill's tier (body, lead auditor, mill) under its synthetic root, labelled", async ({ page }) => {
  await page.goto("./#trust-chain");
  const sec = page.locator("#precursor-trust");
  await expect(sec.getByText("Second tier: the wire-rod mill")).toBeVisible();
  await expect(sec.locator("ol.chain > li")).toHaveCount(6);
  await expect(sec.getByText("Demo Steel Verification B.V. (fictional)")).toBeVisible();
  await expect(sec.getByText("Mei Demo (fictional person)")).toBeVisible();
  await expect(sec.getByText("Demo Wire Rod Co. (fictional)")).toBeVisible();
  await expect(sec.getByText(/not the root the Sepolia demo pins/)).toBeVisible();
});

test("P3 Try to break it, card 5: the same wire rod cannot back a second screw maker (ExceedsVerifiedTonnage, local chain)", async ({ page }) => {
  await page.goto("./#try-to-break-it");
  const card = page.getByTestId("attack-precursor");
  await expect(card.getByRole("heading", { name: "5 · The same wire rod backs two screw makers" })).toBeVisible();
  await expect(card.getByText(/on the local anvil chain when the demo data was built — not on Sepolia/)).toBeVisible();
  await expect(card.getByText(/Reverted: ExceedsVerifiedTonnage \(437\.5 t left, 500 t requested\)/)).toBeVisible();
  await expect(card.getByText(/PRECURSOR_INVALID\/CREDENTIAL/)).toBeVisible();
  await expect(page.getByText(/Six attacks\./)).toBeVisible();
});

test("P4 axe: no violations in the precursor sections, after the re-check, in English and Traditional Chinese", async ({ page }) => {
  await page.goto("./#buyer");
  const sec = page.locator("#precursor");
  await sec.getByRole("button", { name: "Re-check the off-chain parts in this browser" }).click();
  await expect(sec.locator("ul.pc-items > li")).toHaveCount(8);
  await scan(page, "Buyer, precursor section after the re-check");
  await page.goto("./?lang=zh-TW#buyer");
  const zh = page.locator("#precursor");
  await expect(zh.getByText("前驅物（線材）")).toBeVisible();
  await expect(zh.getByTestId("precursor-where")).toContainText("不在 Sepolia");
  await zh.getByRole("button", { name: "在此瀏覽器重新檢查鏈下部分" }).click();
  await expect(zh.locator("ul.pc-items > li")).toHaveCount(8);
  await scan(page, "Buyer (zh-TW), precursor section after the re-check");
  await page.goto("./?lang=zh-TW#try-to-break-it");
  await expect(page.getByTestId("attack-precursor").getByText("5 · 同一批線材替兩家螺絲廠背書")).toBeVisible();
  await page.goto("./?lang=zh-TW#trust-chain");
  await expect(page.getByText("第二層：線材廠")).toBeVisible();
  await scan(page, "Trust chain (zh-TW), precursor tier");
});
