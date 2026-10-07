// Accessibility checks of the demo page: an axe-core scan of each tab in the state a visitor reaches
// (violations of any impact must be zero), the main actions done with the keyboard only, and the
// page without JavaScript (noscript summary and share metadata).
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

async function connected(page: Page) {
  await expect(page.getByText("Connected to Sepolia.").or(page.getByText("Switched to backup node."))).toBeVisible();
}

async function scan(page: Page, label: string) {
  // Scan the settled page: entrance animations finished (mid-fade text would read as low contrast), scrolled to
  // the top (the sticky tab bar would otherwise cover, and so shrink, the targets under it).
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  await page.evaluate(() => window.scrollTo(0, 0));
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  const report = violations.map((v) => `${v.impact} ${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(report, `axe on ${label}`).toEqual([]);
}

/** Presses Tab (or Shift+Tab) until the element is focused, at most `max` times, so a test fails rather than loops. */
async function tabTo(page: Page, target: Locator, { max = 80, back = false } = {}) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press(back ? "Shift+Tab" : "Tab");
  }
  throw new Error("element not reached with the keyboard");
}

test("A1 axe (WCAG 2.2 AA and best practice): no violations of any impact on the six tabs", async ({ page }) => {
  await page.goto("./#verification-body");
  await connected(page);
  await expect(page.getByRole("heading", { name: "Issue a verified emissions report" })).toBeVisible();
  await page.locator("summary", { hasText: "view signature" }).click();
  await scan(page, "Verification body");

  await page.getByRole("tab", { name: "Supplier" }).click();
  await expect(page.locator(".tonnage-legend")).toContainText(/Remaining [\d.]+ t/);
  await page.getByRole("button", { name: "Create the supplier's proof" }).click();
  await scan(page, "Supplier");

  await page.getByRole("tab", { name: "Buyer" }).click();
  await page.getByRole("button", { name: "Load the demo proof" }).click();
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.locator(".overall .stamp")).toBeVisible();
  await page.locator("#check-sources > summary").click();
  await expect(page.locator("#check-sources tbody > tr")).toHaveCount(8);
  await scan(page, "Buyer after Load and Verify, data-source table open");

  await page.getByRole("tab", { name: "Try to break it" }).click();
  await page.getByRole("button", { name: "Change one disclosed number" }).click();
  await expect(page.getByText(/Check 2 failed/)).toBeVisible();
  await scan(page, "Try to break it");

  await page.getByRole("tab", { name: "Trust chain" }).click();
  await expect(page.getByRole("heading", { name: "Who is allowed to sign" })).toBeVisible();
  await page.getByRole("button", { name: "why?" }).click();
  await expect(page.locator("#evidence-why")).toBeVisible();
  await page.locator("#name-vs-chain > summary").click();
  await expect(page.locator("#name-vs-chain .pvv-steps .badge")).toHaveCount(4);
  await scan(page, "Trust chain with the evidence note and the comparison panel open");

  await page.getByRole("tab", { name: "On-chain proof" }).click();
  await expect(page.locator("table.ledger tbody tr")).not.toHaveCount(0);
  await scan(page, "On-chain proof");
});

test("A2 keyboard only: Load, Verify, Accept and download on the Buyer tab", async ({ page }) => {
  await page.goto("./#buyer");
  await connected(page);
  await tabTo(page, page.getByRole("button", { name: "Load the demo proof" }));
  await page.keyboard.press("Enter");
  await expect(page.locator("#proof-in")).toHaveValue(/"core"/);
  await tabTo(page, page.getByRole("button", { name: "Verify", exact: true }));
  await page.keyboard.press("Space");
  await expect(page.locator(".overall .stamp")).toBeVisible();
  const accept = page.getByRole("button", { name: "Accept verified value" });
  test.skip(!(await accept.isEnabled()), "not VALID on the current chain state: nothing to accept or download");
  await tabTo(page, accept, { max: 120 });
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Accepted \(demo\)/)).toBeVisible();
  await tabTo(page, page.getByRole("button", { name: "Download verification record (JSON)" }));
  const download = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  expect((await download).suggestedFilename()).toMatch(/^carbonlei-verification-.*\.json$/);
});

test("A3 keyboard only: the evidence note, the tabs, the comparison panel and the four attacks", async ({ page }) => {
  const data = await (await page.request.get("demo-data.json")).json();
  await page.goto("./#buyer");
  await connected(page);
  // The evidence note on the first screen opens and closes from the keyboard.
  const why = page.getByRole("button", { name: "why?" });
  await tabTo(page, why);
  await page.keyboard.press("Enter");
  await expect(why).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#evidence-why")).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.locator("#evidence-why")).toBeHidden();
  // Only the selected tab is in the Tab order (roving tabindex); the arrow keys move to and open the others.
  // The Trust chain comparison panel opens with Space.
  const trust = page.getByRole("tab", { name: "Trust chain" });
  await expect(trust).toHaveAttribute("tabindex", "-1");
  await tabTo(page, page.getByRole("tab", { name: "Buyer" }));
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(trust).toBeFocused();
  await expect(trust).toHaveAttribute("aria-selected", "true");
  await expect(trust).toHaveAttribute("tabindex", "0");
  const panel = page.locator("details#name-vs-chain");
  await tabTo(page, panel.locator("summary"));
  await page.keyboard.press("Space");
  await expect(panel).toHaveAttribute("open", "");
  await expect(panel.locator(".pvv-steps .badge.pass")).toHaveCount(4);
  // In the tab list, the arrow keys and Home / End move between tabs and open them.
  await tabTo(page, trust, { back: true });
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "On-chain proof" })).toBeFocused();
  await expect(page.getByRole("heading", { name: "On-chain proof" })).toBeVisible();
  await page.keyboard.press("Home");
  await expect(page.getByRole("tab", { name: "Verification body" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Try to break it" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "Try to break it" })).toHaveAttribute("aria-selected", "true");
  // The four attacks, Enter or Space on each button.
  await tabTo(page, page.getByRole("button", { name: "Change one disclosed number" }));
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Check 2 failed: A disclosed value was changed/)).toBeVisible();
  await tabTo(page, page.getByRole("button", { name: "Claim the same batch again" }));
  await page.keyboard.press("Space");
  await expect(page.getByText(/Reverted: BatchAlreadyClaimed/)).toBeVisible();
  await tabTo(page, page.getByRole("button", { name: /Claim \d+ t more/ }));
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Reverted: ExceedsVerifiedTonnage/)).toBeVisible();
  expect(data.attacks.attack4, "demo data has attack 4").toBeTruthy();
  await tabTo(page, page.getByRole("button", { name: "Verify the impostor's proof" }), { max: 120 });
  await page.keyboard.press("Enter");
  await expect(page.locator("ol.a4-checks > li")).toHaveCount(8);
});

test("A4 focus ring: shown when focus comes from the keyboard, not after a mouse click", async ({ page }) => {
  await page.goto("./#buyer");
  await connected(page);
  const load = page.getByRole("button", { name: "Load the demo proof" });
  await load.click();
  await expect(load).toBeFocused();
  expect(await load.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("none");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(load).toBeFocused();
  expect(await load.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  test("A5 the page still says what the demo is, its three checks and where to read more; share metadata present", async ({ page }) => {
    await page.goto("./");
    const ns = page.locator("noscript div");
    await expect(page.getByRole("heading", { name: "CarbonLEI", level: 1 })).toBeVisible();
    await expect(ns).toContainText("needs JavaScript");
    await expect(page.locator("noscript li")).toHaveCount(3);
    await expect(ns.getByRole("link", { name: "README on GitHub" })).toHaveAttribute("href", "https://github.com/zuemen/carbon-lei#readme");
    const meta = (sel: string) => page.locator(`head meta[${sel}]`).getAttribute("content");
    expect(await meta('name="description"')).toContain("who signed a CBAM emissions report");
    expect(await meta('property="og:url"')).toBe("https://zuemen.github.io/carbon-lei/");
    expect(await meta('property="og:type"')).toBe("website");
    expect(await meta('property="og:title"')).toBe("CarbonLEI — demo");
    expect(await meta('property="og:description"')).toBe(await meta('name="description"'));
    expect(await meta('name="twitter:card"')).toBe("summary");
  });
});
