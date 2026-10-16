// Check 8's sub-rules on the verification report (sdk/verification-rules.ts): under check 8 on the Buyer tab (EN and
// zh-TW), the Verifier legitimacy panel on the Trust chain tab, and attack card 6. axe on each.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function axe(page: Page, label: string) {
  // A cancelled animation rejects its finished promise (AbortError): treat it as settled.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  await page.evaluate(() => window.scrollTo(0, 0));
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  expect(
    violations.map((v) => `${v.impact} ${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    `axe on ${label}`,
  ).toEqual([]);
}

test("V1 Buyer: the demo proof (calendar 2026, report dated 15 March 2027) passes check 8 with its sub-rules listed under it", async ({ page }) => {
  await page.goto("./#buyer");
  await page.getByRole("button", { name: "Load the demo proof" }).click();
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  const c8 = page.locator("ol.checks > li").nth(7);
  await expect(c8.locator(".badge")).toHaveText("✓ Passed");
  await expect(page.locator(".overall .stamp")).toHaveText("Verified");
  const rules = c8.locator(".subrules li");
  await expect(c8.locator(".subrules")).toContainText("Rules on the report itself");
  await expect(c8.locator('[data-rule="first-report-date"]')).toContainText("Not dated before verifiers could issue reports (2027-01-01)");
  await expect(c8.locator('[data-rule="site-visit"]')).toContainText("physical site visit stated");
  await expect(c8.locator('[data-rule="valid-at-report"]')).toContainText("no suspension or withdrawal on the report date 2027-03-15");
  await expect(c8.locator('[data-rule="commission-list"]')).toContainText("VERIFIER_PROVENANCE/COMMISSION_LIST_UNPUBLISHED");
  await expect(c8.locator(".subrule.fail, .subrule.warn")).toHaveCount(0);
  expect(await rules.count()).toBeGreaterThanOrEqual(10);
  await axe(page, "Buyer with check 8 sub-rules");
});

test("V2 Buyer in 繁體中文: the sub-rule names are translated, codes are not", async ({ page }) => {
  await page.goto("./?lang=zh-TW#buyer");
  await page.getByRole("button", { name: "Verify the demo proof" }).click();
  const c8 = page.locator("ol.checks > li").nth(7);
  await expect(c8.locator(".subrules")).toContainText("針對報告本身的規則");
  await expect(c8.locator('[data-rule="report-after-period"]')).toContainText("報告日期晚於報告期間結束");
  await expect(c8.locator('[data-rule="commission-list"]')).toContainText("執委會的 CBAM 認證驗證機構名單");
  await expect(c8.locator('[data-rule="commission-list"] code')).toHaveText("VERIFIER_PROVENANCE/COMMISSION_LIST_UNPUBLISHED");
  await axe(page, "Buyer zh-TW with check 8 sub-rules");
});

test("V3 Trust chain: Verifier legitimacy panel — accreditation provenance, every rule passes, the unpublished Commission list as an advisory", async ({ page }) => {
  await page.goto("./#trust-chain");
  const panel = page.locator("section.verifier-legitimacy");
  await expect(panel.locator(".sheet-kicker")).toHaveText("Verifier legitimacy");
  await expect(panel).toContainText("DEMO-ACC-CBAM-0001");
  await expect(panel).toContainText("Demo Accreditation Body (fictional) · DE");
  await expect(panel).toContainText("EN ISO/IEC 17029:2019");
  await expect(panel).toContainText("activity group VIII");
  await expect(panel).toContainText("2026-10-05 → 2030-12-31");
  await expect(panel).toContainText("Report VR-DEMO-0001, dated 2027-03-15");
  await expect(panel.locator(".subrule.pass")).toHaveCount(10);
  await expect(panel.locator(".subrule.fail, .subrule.warn")).toHaveCount(0);
  await expect(panel.locator(".vl-advisory")).toContainText("Commission list not yet published");
  await expect(panel.locator(".vl-advisory")).toContainText("2026-10-16");
  await axe(page, "Trust chain with the Verifier legitimacy panel");
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("V4 Try to break it, card 6: a report dated before verifiers could issue is rejected by check 8", async ({ page }) => {
  await page.goto("./#try-to-break-it");
  // Let the page connect first, so the other cards do not re-render under the axe scan.
  await expect(page.getByText("Connected to Sepolia.").or(page.getByText("Switched to backup node."))).toBeVisible();
  const card = page.locator("#attack-6");
  await expect(card.getByRole("heading", { name: "6 · A verification report dated before verifiers could issue" })).toBeVisible();
  await card.getByRole("button", { name: "Date the report 2026-12-15" }).click();
  await expect(card.locator(".stamp")).toHaveText("Rejected");
  await expect(card.locator(".attack-result > p code")).toHaveText("VERIFICATION_RULE/REPORT_BEFORE_FIRST_ISSUE_DATE");
  await expect(card.locator('[data-rule="first-report-date"].fail')).toBeVisible();
  await expect(card.locator('[data-rule="report-after-period"].fail')).toBeVisible();
  await axe(page, "Try to break it after card 6");
});
