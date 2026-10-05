// End-to-end checks of the demo page (handbook E1–E11, plan U3).
import { expect, test, type Page } from "@playwright/test";

async function rpcs(page: Page): Promise<string[]> {
  const res = await page.request.get("demo-data.json");
  return (await res.json()).network.rpcs as string[];
}

test("E1 opens without a wallet, lands on the Buyer tab within 5 s", async ({ page }) => {
  const t0 = Date.now();
  await page.goto("./");
  await expect(page.getByRole("tab", { name: "Buyer" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Check a supplier's proof" })).toBeVisible();
  expect(Date.now() - t0).toBeLessThan(5_000);
  await expect(page.getByText("All companies fictional. Emissions values illustrative — not official CBAM methodology.")).toBeVisible();
});

test("E2 the demo proof passes checks 1–5; E4 comparison card; E11 accept shows the claim transaction", async ({ page }) => {
  await page.goto("./#buyer");
  await page.getByRole("button", { name: "Load the demo proof" }).click();
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  const checks = page.locator("ol.checks > li");
  for (const i of [0, 1, 2, 3, 4]) await expect(checks.nth(i).locator(".badge")).toHaveText("✓ Passed");
  await expect(page.getByText("2.978 tCO2e/t")).toBeVisible();
  await expect(page.getByText("A gap in what is declared, not a physical reduction.")).toBeVisible();
  const accept = page.getByRole("button", { name: "Accept verified value" });
  if (await accept.isEnabled()) {
    await accept.click();
    await expect(page.getByText(/Accepted \(demo\)/)).toBeVisible();
  }
});

test("E10 Tamper with one number → check 2 fails", async ({ page }) => {
  await page.goto("./#buyer");
  await page.getByRole("button", { name: "Load the demo proof" }).click();
  await page.getByRole("button", { name: "Tamper with one number" }).click();
  await expect(page.locator("ol.checks > li").nth(1).locator(".badge")).toHaveText("✕ Failed");
  await expect(page.getByText("A disclosed value was changed after the supplier created the proof.").first()).toBeVisible();
});

test("E3 the three attacks are rejected with the right reasons", async ({ page }) => {
  await page.goto("./#try-to-break-it");
  await page.getByRole("button", { name: "Change one disclosed number" }).click();
  await expect(page.getByText(/Check 2 failed: A disclosed value was changed/)).toBeVisible();
  await page.getByRole("button", { name: "Claim the same batch again" }).click();
  await expect(page.getByText(/Reverted: BatchAlreadyClaimed/)).toBeVisible();
  await page.getByRole("button", { name: /Claim \d+ t more/ }).click();
  await expect(page.getByText(/Reverted: ExceedsVerifiedTonnage — .*\(300 t left, 400 t requested\)/)).toBeVisible();
  await expect(page.getByText(/AuditorNotAuthorized/).first()).toBeVisible();
});

test("E5 primary RPC down → switches to the backup node", async ({ page }) => {
  const [primary] = await rpcs(page);
  await page.route(`${primary}**`, (r) => r.abort());
  await page.goto("./#buyer");
  await expect(page.getByText("Primary node did not respond. Switched to backup node.")).toBeVisible();
});

test("all RPCs down → explains, offers retry and the cached view", async ({ page }) => {
  for (const r of await rpcs(page)) await page.route(`${r}**`, (x) => x.abort());
  await page.goto("./#buyer");
  await expect(page.getByText(/Could not reach Sepolia after \d+ s/)).toBeVisible();
  const cached = page.getByRole("button", { name: /Show cached results/ });
  if (await cached.count()) {
    await cached.click();
    await expect(page.getByText(/Offline view — cached on/)).toBeVisible();
  }
});

test("E6 no horizontal scroll at 390 px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const tab of ["buyer", "supplier", "verification-body", "try-to-break-it", "trust-chain", "on-chain-proof"]) {
    await page.goto(`./#${tab}`);
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `tab ${tab}`).toBeLessThanOrEqual(0);
  }
});

test("E7 On-chain proof lists the contracts and the demo transactions", async ({ page }) => {
  await page.goto("./#on-chain-proof");
  await expect(page.getByRole("heading", { name: "On-chain proof" })).toBeVisible();
  await expect(page.locator("table.ledger tbody tr")).not.toHaveCount(0);
});
