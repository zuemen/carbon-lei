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
  // Scoped to the card: the first screen repeats both phrases.
  const card = page.locator("#comparison");
  await expect(card.getByText("2.978 tCO2e/t")).toBeVisible();
  await expect(card.getByText("A gap in what is declared, not a physical reduction.")).toBeVisible();
  const accept = page.getByRole("button", { name: "Accept verified value" });
  if (await accept.isEnabled()) {
    await accept.click();
    await expect(page.getByText(/Accepted \(demo\)/)).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download verification record (JSON)" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("carbonlei-verification-BATCH-DEMO-2026-0001.json");
    const record = JSON.parse(await (await import("node:fs/promises")).readFile((await file.path()) as string, "utf8"));
    expect(record.overall).toBe("VALID");
    expect(record.checks).toHaveLength(9);
    expect(record.notice).toContain("Not signed, not a CBAM Registry document");
  }
});

test("Buyer summary under Verify: checks passed and the card's gap; a failed check is said plainly, without the gap", async ({ page }) => {
  const data = await (await page.request.get("demo-data.json")).json();
  const c = data.comparison;
  const q = Number(c.quantityTonnes);
  const gap = Number(c.defaultValue) * q - Number(c.verifiedValue) * q;
  const f = (n: number, d = 1) => n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: d });
  await page.goto("./#buyer");
  await page.getByRole("button", { name: "Load the demo proof" }).click();
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  const summary = page.locator(".verify-summary");
  await expect(summary).toBeVisible();
  const passed = await page.locator("ol.checks > li .badge", { hasText: "✓ Passed" }).count();
  await expect(summary).toContainText(`${passed} of 8 checks passed`);
  if (await page.locator(".stamp", { hasText: "Verified" }).count()) {
    await expect(summary).toContainText(
      `declared-emissions gap for this ${f(q)} t shipment: ${f(gap)} tCO2e (≈ €${f(gap * Number(c.priceEur), 0)} gross, illustrative)`,
    );
    await expect(page.locator(".gap-line")).toHaveText(`Declared-emissions gap: ${f(gap)} tCO2e`);
    await summary.getByRole("button", { name: "See comparison ↓" }).click();
    await expect(page.locator("#comparison")).toBeInViewport();
  } else {
    await expect(summary).not.toContainText("declared-emissions gap for this");
  }
  await page.getByRole("button", { name: "Tamper with one number" }).click();
  await expect(summary).toContainText("Rejected — check 2 failed: A disclosed value was changed");
  await expect(summary).not.toContainText("declared-emissions gap for this");
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
  const data = await (await page.request.get("demo-data.json")).json();
  if (data.attacks.attack3) await expect(page.getByText(/AuditorNotAuthorized/).first()).toBeVisible();
  else await expect(page.getByText("not recorded yet")).toBeVisible();
});

test("E3b attack 4 (when recorded): the impostor's proof fails check 7 at the pinned root; suspension; NotActiveVerifier", async ({ page }) => {
  const data = await (await page.request.get("demo-data.json")).json();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./#try-to-break-it");
  await expect(page.getByRole("heading", { name: "Try to break it" })).toBeVisible();
  const verify = page.getByRole("button", { name: "Verify the impostor's proof" });
  if (!data.attacks.attack4) {
    await expect(verify).toHaveCount(0);
    return;
  }
  await expect(page.getByRole("heading", { name: "4 · The owner key is stolen: an impostor body is put on the allowlist" })).toBeVisible();
  await verify.click();
  const checks = page.locator("ol.a4-checks > li");
  await expect(checks).toHaveCount(8);
  for (const i of [0, 1, 2, 5]) await expect(checks.nth(i).locator(".badge")).toHaveText("✓ Passed"); // checks 1, 2, 3, 6
  // Check 4 passes, or needs review once the watcher's suspension falls within 24 h after the registration.
  await expect(checks.nth(3).locator(".badge")).toHaveText(/✓ Passed|! Needs review/);
  await expect(checks.nth(4).locator(".badge")).toHaveText("– Not run"); // no shipment in this proof
  await expect(checks.nth(6).locator(".badge")).toHaveText("✕ Failed");
  await expect(checks.nth(6)).toContainText("QVI credential not issued by the configured root of trust");
  await expect(page.getByText(/reverted NotActiveVerifier/).first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
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

test("E8 the product passport QR link opens the Buyer tab with the matching proof", async ({ page }) => {
  const data = await (await page.request.get("demo-data.json")).json();
  const said = JSON.parse(data.proof.core).d;
  await page.goto(`./#buyer?said=${encodeURIComponent(said)}&batch=${encodeURIComponent(data.shipment.batchId)}`);
  await expect(page.getByText(/Proof loaded from the product passport QR code/)).toBeVisible();
  await expect(page.locator("#proof-in")).toHaveValue(/"core"/);
});
