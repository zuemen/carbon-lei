// Supplier tab, Allocations: one verified report shared with several buyers. Row 1 is the real Sepolia claim (read
// live), rows 2-3 are fictional planned allocations; the reconciliation and the proofs use sdk/allocation.ts.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function connected(page: Page) {
  await expect(page.getByText("Connected to Sepolia.").or(page.getByText("Switched to backup node.")).or(page.getByText("已連線"))).toBeVisible();
}

async function scan(page: Page, label: string) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  await page.evaluate(() => window.scrollTo(0, 0));
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  const report = violations.map((v) => `${v.impact} ${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(report, `axe on ${label}`).toEqual([]);
}

const section = (page: Page) => page.locator("section.alloc");
const rows = (page: Page) => section(page).locator("tbody tr");

async function openAllocations(page: Page, lang = "") {
  await page.goto(`./${lang}#supplier`);
  await expect(section(page).getByText(/Read live from Sepolia at block \d+|於區塊 \d+ 即時讀取 Sepolia/)).toBeVisible();
}

test("AL1 allocations: the live Sepolia claim, two planned rows, remaining 300 t, the 400 t request flagged as refused like attack 2b", async ({ page }) => {
  await openAllocations(page);
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).nth(0)).toContainText("BATCH-DEMO-2026-0001");
  await expect(rows(page).nth(0)).toContainText("On-chain claim (Sepolia)");
  await expect(rows(page).nth(0)).toContainText("200");
  await expect(rows(page).nth(1)).toContainText("Would be refused");
  await expect(rows(page).nth(2)).toContainText("Planned, not on-chain");
  await expect(section(page).locator(".alloc-summary")).toContainText("Verified 500 t · claimed on-chain 200 t · remaining 300 t · planned that fits 80 t · would be refused 400 t");
  const warn = section(page).locator(".alloc-warn");
  await expect(warn).toContainText("BATCH-DEMO-2026-0002 asks for 400 t but only 300 t are left");
  await expect(warn).toContainText("ExceedsVerifiedTonnage");
  await expect(section(page)).toContainText("fictional and exist only in this browser");

  // Lowering the request to what is left removes the warning.
  await page.getByRole("spinbutton", { name: /Planned quantity in tonnes for Demo Schrauben/ }).fill("200");
  await expect(section(page).locator(".alloc-ok")).toHaveText("All planned allocations fit in the remaining tonnes.");
  await expect(rows(page).nth(1)).toContainText("Planned, not on-chain");
  await expect(section(page).locator(".alloc-summary")).toContainText("planned that fits 280 t");

  await page.getByRole("spinbutton", { name: /Planned quantity in tonnes for Demo Schrauben/ }).fill("400");
  await section(page).getByRole("button", { name: "See attack 2b" }).click();
  await expect(page.locator("#attack-2b")).toBeVisible();
});

test("AL2 allocations: the contract check by eth_call refuses the 400 t row and accepts the 80 t row", async ({ page }) => {
  await openAllocations(page);
  await connected(page);
  await section(page).getByRole("button", { name: /Check each planned row with the contract/ }).click();
  await expect(rows(page).nth(1).locator(".alloc-dry")).toHaveText("eth_call: refused — ExceedsVerifiedTonnage (300 t left, 400 t asked)");
  await expect(rows(page).nth(2).locator(".alloc-dry")).toHaveText("eth_call: accepted");
});

test("AL3 allocations: proofs for all buyers — one download per buyer with its own fields; the claimed buyer's proof verifies in the Buyer tab", async ({ page }) => {
  await openAllocations(page);
  await page.getByRole("combobox", { name: /Fields for Demo Nordic/ }).selectOption("minimal");
  await section(page).getByRole("button", { name: "Make proofs for all buyers" }).click();
  const pack = section(page).locator(".alloc-pack li");
  await expect(pack).toHaveCount(3);
  await expect(pack.nth(0)).toContainText("21 fields · verifies now for this buyer's EORI");
  await expect(pack.nth(1)).toContainText("no proof: the contract would refuse this claim");
  await expect(pack.nth(2)).toContainText("11 fields · verifies only after the claim is sent");

  const [download] = await Promise.all([page.waitForEvent("download"), pack.nth(2).getByRole("link").click()]);
  expect(download.suggestedFilename()).toBe("demo-nordic--BATCH-DEMO-2026-0003.proof.json");
  const proof = JSON.parse(await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString("utf8")));
  expect(proof.disclosures).toHaveLength(11);
  expect(proof.shipment.batchId).toBe("BATCH-DEMO-2026-0003");

  await pack.nth(0).getByRole("button", { name: "Open in the Buyer tab →" }).click();
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.locator(".overall .stamp")).toBeVisible();
  await expect(page.locator("ol.checks > li", { hasText: "This batch was claimed for you, for this quantity" })).toContainText("✓ Passed");
});

test("AL4 allocations in 繁體中文 and on a 390 px phone: translated, no sideways scroll, axe clean", async ({ page }) => {
  await openAllocations(page, "?lang=zh-TW");
  await expect(section(page).getByRole("heading", { name: "分配——一份經驗證報告，多位買方" })).toBeVisible();
  await expect(section(page).locator(".alloc-warn")).toContainText("合約會拒絕這筆申領");
  await section(page).getByRole("button", { name: "為所有買方產生證明" }).click();
  await expect(section(page).locator(".alloc-pack li").first()).toContainText("現在即可對此買方的 EORI 驗證通過");
  await scan(page, "Supplier allocations in 繁體中文");

  await page.setViewportSize({ width: 390, height: 844 });
  await openAllocations(page);
  await section(page).getByRole("button", { name: "Make proofs for all buyers" }).click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const tableOverflow = await section(page).locator(".table-wrap").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(tableOverflow).toBeLessThanOrEqual(0);
  expect(await rows(page).first().evaluate((el) => getComputedStyle(el).display)).toBe("block");
  await scan(page, "Supplier allocations at 390 px");
});
