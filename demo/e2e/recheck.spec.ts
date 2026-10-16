// Importer workbench › Re-check accepted lines (sdk/recheck.ts): line 1 re-verified live on Sepolia, lines 2–5
// illustrative outcomes, the plan moves a line that needs action to the default; and the Buyer tab's verification
// record now carries the proof so `carbonlei recheck` can re-verify it later.
// Figures by hand: CN 7318 from Taiwan, 2026 default with mark-up 2.978 tCO2e/t.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function scan(page: Page, label: string) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
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
const item = (page: Page, id: string) => page.locator(`.rc-list li[data-line="${id}"]`);

test("R1 re-check: line 1 re-verified live and unchanged; the illustrative auditor revocation moves line 2 to the default", async ({ page }) => {
  await openVerified(page);
  const byId = (id: string) => rows(page).filter({ hasText: id });
  await expect(byId("FNW-2026-014").locator(".wb-basis")).toHaveText("verified");
  await expect(page.locator(".wb-embedded")).toHaveText("1,267.16 tCO2e");

  await page.getByRole("button", { name: "Re-check accepted lines" }).click();
  const status = page.locator(".wb-recheck-status");
  await expect(status).toContainText(/Line 1 re-verified live at block \d+/, { timeout: 60_000 });
  await expect(page.locator(".rc-list > li")).toHaveCount(5);
  // Line 1: accepted when the tab opened, long after the report's 24 h window closed → unchanged.
  const live = item(page, "BATCH-DEMO-2026-0001");
  await expect(live).toContainText("No change");
  await expect(live).toContainText("Unchanged: still VALID");
  await expect(live).toContainText(/live, block \d+/);
  await expect(live).toContainText("accepted VALID → now VALID");
  // Illustrative outcomes, each labelled.
  const fnw = item(page, "FNW-2026-014");
  await expect(fnw).toContainText("Action needed");
  await expect(fnw).toContainText("Auditor revoked within 24 h of registration → review; default meanwhile");
  await expect(fnw).toContainText("(illustrative)");
  await expect(fnw.locator(".rc-action")).toContainText("Declare this line on the default value");
  await expect(item(page, "HFC-2026-009")).toContainText("Became final: the CONTESTED window closed with no event");
  await expect(item(page, "KRC-2026-003")).toContainText("Still not on the verified value");
  await expect(item(page, "TWL-2026-021")).toContainText("accepted INVALID → now INVALID");
  await expect(page.locator(".rc-list")).not.toContainText("TBI-2026-030");

  // The plan: line 2 now on the default, 120 t × 2.978 = 357.36 (was 120 × 2.1 = 252);
  // total 1,267.16 − 252 + 357.36 = 1,372.52 tCO2e; certificates 1,373; gap 1,608.12 − 1,372.52 = 235.6.
  await expect(byId("FNW-2026-014").locator(".wb-basis")).toHaveText("default");
  await expect(byId("FNW-2026-014").locator(".wb-reason")).toContainText(
    "re-checked after acceptance: AUDITOR_REVOKED_OR_BODY_SUSPENDED (illustrative re-check)",
  );
  await expect(byId("FNW-2026-014").locator(".wb-emb")).toHaveText("357.36");
  await expect(byId("BATCH-DEMO-2026-0001").locator(".wb-basis")).toHaveText("verified");
  await expect(page.locator(".wb-embedded")).toHaveText("1,372.52 tCO2e");
  await expect(page.locator(".wb-certs")).toHaveText("1,373");
  await expect(page.locator(".wb-gap")).toHaveText("235.6 tCO2e");
});

test("R2 re-check a11y: keyboard, axe with results shown (English and 繁體中文)", async ({ page }) => {
  await openVerified(page);
  const button = page.getByRole("button", { name: "Re-check accepted lines" });
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".wb-recheck-status")).toContainText(/re-verified live at block \d+/, { timeout: 60_000 });
  await scan(page, "Importer workbench after re-check");

  await openVerified(page, "./?lang=zh-TW#importer-workbench");
  await page.getByRole("button", { name: "重新檢查已接受的行" }).click();
  await expect(page.locator(".wb-recheck-status")).toContainText(/第 1 行已於區塊 \d+ 即時重新驗證/, { timeout: 60_000 });
  await expect(item(page, "FNW-2026-014")).toContainText("需處理");
  await expect(item(page, "FNW-2026-014")).toContainText("登記後 24 小時內查核員遭撤銷 → 人工複核，期間用預設值");
  await expect(item(page, "FNW-2026-014")).toContainText("示意");
  await expect(item(page, "BATCH-DEMO-2026-0001")).toContainText("無變更");
  await expect(rows(page).filter({ hasText: "FNW-2026-014" }).locator(".wb-reason")).toContainText(
    "接受後重新檢查：AUDITOR_REVOKED_OR_BODY_SUSPENDED（示意重新檢查）",
  );
  await scan(page, "進口商工作台（重新檢查後）");
});

test("R3 the Buyer tab's verification record carries the proof, so carbonlei recheck can re-verify it", async ({ page }) => {
  const data = await (await page.request.get("demo-data.json")).json();
  await page.goto("./#buyer");
  await page.getByRole("button", { name: "Load the demo proof" }).click();
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  const accept = page.getByRole("button", { name: "Accept verified value" });
  await expect(accept).toBeEnabled({ timeout: 60_000 });
  await accept.click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download verification record (JSON)" }).click();
  const record = JSON.parse(await readFile((await (await download).path()) as string, "utf8"));
  expect(record.kind).toBe("CarbonLEI verification record (demo)");
  expect(record.overall).toBe("VALID");
  expect(record.proof.core).toBe(data.proof.core);
  expect(record.proof.signature).toBe(data.proof.signature);
  expect(record.credSAID).toBe(JSON.parse(data.proof.core).d);
});
