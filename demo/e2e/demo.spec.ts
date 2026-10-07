// End-to-end checks of the demo page (handbook E1–E11, plan U3).
import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { reportKeyOf } from "../../sdk/commitment.ts";
import { decodeDisclosure } from "../../sdk/disclosure.ts";
import { PACT_SPEC_VERSION, pactIdOf } from "../../sdk/pact.ts";

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
      `declared-emissions gap for this ${f(q)} t shipment: ${f(gap)} tCO2e (gross, illustrative)`,
    );
    await expect(page.locator(".gap-line")).toHaveText(`Declared-emissions gap: ${f(gap)} tCO2e`);
    await summary.getByRole("button", { name: "See comparison ↓" }).click();
    await expect(page.locator("#comparison")).toBeInViewport();
  } else {
    await expect(summary).not.toContainText("declared-emissions gap for this");
  }
  await expect(page.locator(".overall")).toContainText("5 fields hidden by supplier.");
  await expect(page.locator(".overall")).not.toContainText("rejected");
  await page.getByRole("button", { name: "Tamper with one number" }).click();
  await expect(summary).toContainText("Rejected — check 2 failed: A disclosed value was changed");
  await expect(page.locator(".overall")).toContainText("5 fields hidden by supplier · 1 disclosure rejected.");
  await expect(summary).not.toContainText("declared-emissions gap for this");
  // The comparison card shows no verified value and no gap for a rejected proof.
  const card = page.locator("#comparison");
  await expect(card.locator(".no-verified-value")).toHaveText(/No verified value: the proof failed check 2/);
  await expect(card).not.toContainText(/Declared-emissions gap/);
  await expect(card).not.toContainText(/Verified value \(illustrative\)/);
  await expect(card.locator(".gap-line")).toHaveCount(0);
  await expect(card.getByLabel(/What if the verified value were/)).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Accept verified value" })).toBeDisabled();
});

test("Buyer what-if slider: hypothetical figures follow the formula at the card's price, keyboard operable", async ({ page }) => {
  const c = (await (await page.request.get("demo-data.json")).json()).comparison;
  const [def, price, q] = [Number(c.defaultValue), Number(c.priceEur), Number(c.quantityTonnes)];
  const f = (n: number, d = 1) => n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: d });
  const e2 = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  await page.goto("./#buyer");
  const card = page.locator("#comparison");
  const slider = card.getByLabel(/What if the verified value were/);
  const out = card.locator(".whatif-out");
  await expect(out).toHaveAttribute("aria-live", "polite");
  const expectFigures = async (x: number) => {
    const gap = Math.max(0, def - x);
    await expect(out.locator("dd").nth(0)).toHaveText(`${f(gap, 3)} tCO2e`);
    await expect(out.locator("dd").nth(1)).toHaveText(`€${e2(gap * price)}`);
    await expect(out.locator("dd").nth(2)).toHaveText(`€${f(gap * price * q, 0)}`);
  };
  // Starts at the proof's verified value: the shipment figure equals the card's gross figure.
  await expect(slider).toHaveValue(c.verifiedValue);
  await expectFigures(Number(c.verifiedValue));
  const gap = def * q - Number(c.verifiedValue) * q;
  await expect(out.locator("dd").nth(2)).toHaveText(`€${f(gap * price, 0)}`);
  await expect(card.locator(".whatif-rate")).toContainText(`about €${e2(0.1 * price)} per tonne of goods`);
  await expect(card.locator(".whatif-rate")).toContainText("(gross, illustrative)");
  // Neutral wording: what a lower verified intensity is worth, not who gains it.
  await expect(card.locator(".whatif-head")).toContainText("What a lower verified intensity is worth");
  await expect(card.locator(".whatif-head .tag-hypo")).toHaveText("Hypothetical");
  await expect(card.locator(".whatif-rate")).toContainText("each 0.1 tCO2e/t of verified intensity accounts for about");
  await expect(card.locator(".whatif-point")).toContainText(
    "That value depends on the buyer trusting who signed the verified value and that its tonnes were not claimed before",
  );
  await expect(card.locator(".whatif-point")).toContainText("Who captures it is a commercial matter between buyer and producer.");
  await expect(card.locator(".whatif")).not.toContainText(/premium|pay less|\btax|\bsav(e|es|ed|ing|ings)\b/i);
  // Keyboard: three steps down, then to the CBAM default (gap 0).
  await slider.focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
  const lower = Math.round((Number(c.verifiedValue) - 0.3) * 10) / 10;
  await expect(slider).toHaveValue(String(lower));
  await expect(card.locator(".whatif-label")).toHaveText(`What if the verified value were ${f(lower, 3)} tCO2e/t?`);
  await expectFigures(lower);
  await page.keyboard.press("End");
  await expect(card.locator(".whatif-label")).toContainText("(the CBAM default)");
  await expectFigures(def);
  // The verified figures above the slider never change.
  await expect(card.locator(".gap-line")).toHaveText(`Declared-emissions gap: ${f(gap)} tCO2e`);
  await expect(card.locator(".compare")).toContainText(`${c.verifiedValue} tCO2e/t`);
});

/** The Supplier tab's ledger legend: verified, claimed and remaining tonnes (once the values are read). */
async function supplierLedger(page: Page) {
  await page.getByRole("tab", { name: "Supplier" }).click();
  const legend = page.locator(".tonnage-legend");
  await expect(legend).toContainText(/Remaining [\d.]+ t/);
  const text = await legend.innerText();
  const num = (label: string) => new RegExp(`${label} ([\\d.]+) t`).exec(text)?.[1] ?? "";
  return { verified: num("Verified"), claimed: num("Claimed"), left: num("Remaining") };
}

test("First screen ledger strip: the Supplier tab's ledger values, the second importer's claim refused, one line, a link to card 2b", async ({ page }) => {
  const data = await (await page.request.get("demo-data.json")).json();
  await page.goto("./#buyer");
  await expect(page.getByText("Connected to Sepolia.").or(page.getByText("Switched to backup node."))).toBeVisible();
  const strip = page.locator(".ledger-strip");
  const ledger = await supplierLedger(page);
  expect(ledger.verified).toBe(data.report.verifiedTonnes);
  await expect(strip.locator(".ledger-verified")).toHaveText(ledger.verified);
  await expect(strip.locator(".ledger-claimed")).toHaveText(ledger.claimed);
  await expect(strip.locator(".ledger-left")).toHaveText(ledger.left);
  await expect(strip.locator(".ledger-second")).toHaveText(data.attacks.secondImporter.quantityTonnes);
  expect(Number(data.attacks.secondImporter.quantityTonnes)).toBeGreaterThan(Number(ledger.left));
  await expect(strip.locator(".ledger-refusal")).toHaveText(
    `— a ${data.attacks.secondImporter.quantityTonnes} t claim for a second importer is refused.`,
  );
  // One line at 1280 px (the default viewport here is 1280 wide).
  expect(page.viewportSize()?.width).toBe(1280);
  const lines = await strip.evaluate((el) => {
    const cs = getComputedStyle(el);
    return Math.round((el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / parseFloat(cs.lineHeight));
  });
  expect(lines).toBe(1);
  // The link opens Try to break it and focuses card 2b.
  await strip.getByRole("link", { name: /^Try it \(2b\)/ }).click();
  await expect(page.getByRole("tab", { name: "Try to break it" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#attack-2b")).toBeFocused();
  await expect(page.locator("#attack-2b")).toBeInViewport();
});

test("First screen ledger strip in the offline view: the cached ledger, as on the Supplier tab", async ({ page }) => {
  const data = await (await page.request.get("demo-data.json")).json();
  test.skip(!data.cached, "no cached snapshot in this demo data");
  for (const r of data.network.rpcs as string[]) await page.route(`${r}**`, (x) => x.abort());
  await page.goto("./#buyer");
  await page.getByRole("button", { name: /Show cached results/ }).click();
  await expect(page.getByText(/Offline view — cached on/)).toBeVisible();
  const strip = page.locator(".ledger-strip");
  const ledger = await supplierLedger(page);
  expect(BigInt(Math.round(Number(ledger.left) * 1000))).toBe(BigInt(data.cached.remainingKg));
  await expect(strip.locator(".ledger-verified")).toHaveText(ledger.verified);
  await expect(strip.locator(".ledger-claimed")).toHaveText(ledger.claimed);
  await expect(strip.locator(".ledger-left")).toHaveText(ledger.left);
});

test("PACT download after a VALID verification: the SDK's ProductFootprint of the verified credential; none when rejected", async ({ page }) => {
  const data = await (await page.request.get("demo-data.json")).json();
  const credSAID = JSON.parse(data.proof.core).d as string;
  const disclosed = Object.fromEntries(
    (data.proof.disclosures as string[]).map((d) => decodeDisclosure(d)).map((d) => [d.name, d.value]),
  );
  const pactButton = page.getByRole("button", { name: "Download PACT product footprint (JSON)" });
  await page.goto("./#buyer");
  await page.getByRole("button", { name: "Load the demo proof" }).click();
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.locator(".overall .stamp")).toBeVisible();
  const accept = page.getByRole("button", { name: "Accept verified value" });
  if (await accept.isEnabled()) {
    await accept.click();
    await expect(page.getByText("Not a conformance claim and not connected to any PACT network.")).toBeVisible();
    const download = page.waitForEvent("download");
    await pactButton.click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`carbonlei-pact-${data.shipment.batchId}.json`);
    const pf = JSON.parse(await (await import("node:fs/promises")).readFile((await file.path()) as string, "utf8"));
    expect(pf.specVersion).toBe(PACT_SPEC_VERSION);
    expect(pf.specVersion).toMatch(/^3\.0\.\d+$/);
    expect(pf.id).toBe(pactIdOf(reportKeyOf(credSAID)));
    expect(pf.status).toBe("Active");
    expect(pf.companyName).toBe("Demo Fasteners Co. (fictional)");
    expect(pf.companyIds).toEqual([`urn:lei:${disclosed.supplierLEI}`]);
    expect(pf.productIds).toEqual(["urn:pact:zuemen.github.io:product-id:hex-bolt-m10"]);
    expect(pf.productClassifications).toEqual([`urn:pact:ec.europa.eu:cn:${data.report.cnCode}`]);
    expect(pf.pcf.pcfExcludingBiogenicUptake).toBe(disclosed.specificEmbeddedEmissions_tCO2e_per_t);
    expect(pf.pcf.boundaryProcessesDescription).toContain("not a full product carbon footprint");
    const ext = pf.extensions[0].data.carbonlei;
    expect(ext.credSAID).toBe(credSAID);
    expect(ext.registry).toEqual({
      chainId: data.network.chainId,
      contract: data.deployment.contracts.EmissionsClaimRegistry.address,
      reportKey: reportKeyOf(credSAID),
    });
    expect(ext.kelSeq).toBe(data.credential.kelSeq);
  }
  // A rejected proof gets no PACT button.
  await page.getByRole("button", { name: "Tamper with one number" }).click();
  await expect(page.locator(".overall .stamp")).toHaveText("Rejected");
  await expect(pactButton).toHaveCount(0);
});

test("E10 Tamper with one number → check 2 fails", async ({ page }) => {
  await page.goto("./#buyer");
  await page.getByRole("button", { name: "Load the demo proof" }).click();
  await page.getByRole("button", { name: "Tamper with one number" }).click();
  await expect(page.locator("ol.checks > li").nth(1).locator(".badge")).toHaveText("✕ Failed");
  await expect(page.getByText("A disclosed value was changed after the supplier created the proof.").first()).toBeVisible();  // Check 8 is skipped because check 2 rejected the field, not because the supplier hid it.
  await expect(page.locator("ol.checks")).toContainText("rejected by check 2");
  await expect(page.locator("ol.checks")).not.toContainText("were not disclosed");
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

/** True for a JSON-RPC request for the latest block (the head the verifier checks the age of). */
function isLatestBlock(body: unknown): boolean {
  const b = body as { method?: unknown; params?: unknown[] } | null;
  return b?.method === "eth_getBlockByNumber" && Array.isArray(b.params) && b.params[0] === "latest";
}

test("every node 10 minutes behind → the status line says so instead of Connected; Verify refuses the old head", async ({ page }) => {
  for (const r of await rpcs(page)) {
    await page.route(`${r}**`, async (route) => {
      if (!isLatestBlock(route.request().postDataJSON())) return route.continue();
      const res = await route.fetch();
      const json = await res.json();
      if (json.result) json.result.timestamp = `0x${(parseInt(json.result.timestamp, 16) - 600).toString(16)}`;
      await route.fulfill({ response: res, json });
    });
  }
  await page.goto("./#buyer");
  await expect(page.getByText(/^Sepolia nodes are behind: the newest block they report is \d+ s old, more than the 300 s allowed/)).toBeVisible();
  await expect(page.getByText("Connected to Sepolia.")).toHaveCount(0);
  await page.getByRole("button", { name: "Load the demo proof" }).click();
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByText(/Verification could not finish: RPC node is behind: its latest block \d+ is \d+ s old/)).toBeVisible();
  await expect(page.locator(".overall .stamp")).toHaveCount(0);
});

test("the primary node answers every event search with no events → the events are read from the next node: 8 of 8", async ({ page }) => {
  const [primary, ...others] = await rpcs(page);
  const searched: string[] = [];
  for (const r of [primary, ...others]) {
    await page.route(`${r}**`, async (route) => {
      const body = route.request().postDataJSON() as { id?: unknown; method?: unknown } | null;
      if (body?.method !== "eth_getLogs") return route.continue();
      searched.push(r);
      if (r !== primary) return route.continue();
      await route.fulfill({ json: { jsonrpc: "2.0", id: body.id, result: [] }, headers: { "access-control-allow-origin": "*" } });
    });
  }
  await page.goto("./#buyer");
  await expect(page.getByText("Connected to Sepolia.")).toBeVisible();
  await page.getByRole("button", { name: "Load the demo proof" }).click();
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.locator(".overall .stamp")).toBeVisible();
  await expect(page.getByText(/8 of 8 checks passed/).first()).toBeVisible();
  await expect(page.getByText(/incomplete event history/)).toHaveCount(0);
  expect(searched[0]).toBe(primary);
  expect(searched.some((r) => r !== primary)).toBe(true);
});

test("Verify waits more than about 3 s for a node → a progress line while it waits, gone with the result", async ({ page }) => {
  const nodes = await rpcs(page);
  await page.goto("./#buyer");
  await expect(page.getByText("Connected to Sepolia.").or(page.getByText("Switched to backup node."))).toBeVisible();
  const hint = page.getByText("Waiting for a Sepolia node…");
  await page.getByRole("button", { name: "Load the demo proof" }).click();
  await expect(hint).toHaveCount(0);
  // The verification's first read of the head answers after 4.5 s (under the 8 s timeout, so no node is switched).
  let delayed = false;
  for (const r of nodes) {
    await page.route(`${r}**`, async (route) => {
      if (!delayed && isLatestBlock(route.request().postDataJSON())) {
        delayed = true;
        await new Promise((x) => setTimeout(x, 4_500));
      }
      await route.continue();
    });
  }
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(hint).toBeVisible();
  await expect(page.locator(".overall .stamp")).toBeVisible();
  await expect(hint).toHaveCount(0);
  await expect(page.getByText(/8 of 8 checks passed/).first()).toBeVisible();
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

test("Trust chain: name field vs signature chain panel, collapsed by default, opens by keyboard, values from the evidence", async ({ page }) => {
  const data = await (await page.request.get("demo-data.json")).json();
  await page.goto("./#trust-chain");
  const panel = page.locator("details#name-vs-chain");
  await expect(panel).not.toHaveAttribute("open");
  await expect(page.locator("li.node")).toHaveCount(data.trustChain.length);
  const summary = panel.locator("summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(panel).toHaveAttribute("open", "");
  const left = panel.locator(".pvv-col").nth(0);
  const right = panel.locator(".pvv-col").nth(1);
  await expect(left).toContainText("providerName");
  await expect(left).toContainText("companyName");
  await expect(left).toContainText(`"${data.proof.reportExtract.verifierName}"`);
  await expect(left).toContainText("PACT itself does not sign who the provider is");
  await expect(right).toContainText("LE vLEI");
  await expect(right).toContainText(`LEI ${JSON.parse(data.proof.core).issuer.verifierLEI}`);
  await expect(right).toContainText("ECR vLEI");
  await expect(right).toContainText(`key event #${data.credential.kelSeq}`);
  await expect(right).toContainText(/witnesses (\d+)\/\1/);
  await expect(right.locator(".badge.pass")).toHaveCount(4);
  // Key rotation: loaded only when opened; offline evidence from a keripy test identifier.
  const rotation = panel.locator("details#key-rotation");
  await expect(rotation).not.toHaveAttribute("open");
  await expect(rotation.locator(".pvv-rot-steps")).toHaveCount(0);
  await rotation.locator("summary").click();
  await expect(rotation).toContainText("Offline KERI evidence from a test identifier (keripy 1.2.13), not on Sepolia.");
  await expect(rotation).toContainText("key in force at event #3 (1 rotation since inception)");
  await expect(rotation).toContainText("rejected");
  await expect(rotation).toContainText("the event's signature does not verify with the auditor's key in force at event #3");
  await expect(rotation).toContainText(/allowlist transactions: 0/i);
  await expect(rotation.locator(".pvv-rot-steps .badge.pass")).toHaveCount(4);
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("Buyer: where each check gets its data, collapsed by default; eight rows with the check list's own source labels", async ({ page }) => {
  const data = await (await page.request.get("demo-data.json")).json();
  await page.goto("./#buyer");
  const panel = page.locator("details#check-sources");
  await expect(panel).not.toHaveAttribute("open");
  await expect(panel.locator("table")).toBeHidden();
  const checks = page.locator("ol.checks > li");
  await expect(checks).toHaveCount(8);
  await panel.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(panel).toHaveAttribute("open", "");
  const rows = panel.locator("tbody > tr");
  await expect(rows).toHaveCount(8);
  for (let i = 0; i < 8; i++) {
    const check = checks.nth(i);
    const row = rows.nth(i);
    // Same number and wording as the check list, and the same source label text.
    const text = ((await check.locator(".check-text").textContent()) ?? "").replace(/^Check \d+:\s*/, "").trim();
    const name = (await row.locator("td").nth(0).innerText()).trim();
    expect(name.startsWith(`${i + 1}. `), name).toBe(true);
    expect(text.startsWith(name.slice(`${i + 1}. `.length)), `${name} vs ${text}`).toBe(true);
    await expect(row.locator("td").nth(1).locator(".source")).toHaveText(await check.locator(".source").innerText());
  }
  await expect(rows.nth(6).locator("td").nth(1)).toContainText(`exported evidence · ${data.exportDate}`);
  await expect(rows.nth(6).locator("td").nth(2)).toContainText("Witnesses are not queried");
  await expect(rows.nth(6).locator("td").nth(2)).toContainText("judges authority at the report's registration time, as check 4 does");
  await expect(rows.nth(7).locator("td").nth(1)).toContainText("advisory");
  await expect(panel.locator('tr[data-source="sepolia"]')).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("E7 On-chain proof lists the contracts and the demo transactions", async ({ page }) => {
  await page.goto("./#on-chain-proof");
  await expect(page.getByRole("heading", { name: "On-chain proof" })).toBeVisible();
  await expect(page.locator("table.ledger tbody tr")).not.toHaveCount(0);
});

test("E8 the product passport QR link, and the desktop link under the QR, open the Buyer tab with the matching proof", async ({ page }) => {
  const data = await (await page.request.get("demo-data.json")).json();
  const said = JSON.parse(data.proof.core).d;
  const hash = `#buyer?said=${encodeURIComponent(said)}&batch=${encodeURIComponent(data.shipment.batchId)}`;
  await page.goto(`./${hash}`);
  await expect(page.getByText(/Proof loaded from the product passport QR code/)).toBeVisible();
  await expect(page.locator("#proof-in")).toHaveValue(/"core"/);

  // A desktop reviewer cannot scan their own screen: the same link is clickable under the QR.
  await page.goto("./#supplier");
  await page.reload(); // a fresh page, so the proof is not already loaded from the first visit
  const link = page.getByRole("link", { name: "Open the same link here" });
  await expect(link).toHaveAttribute("href", hash);
  await link.click();
  await expect(page.getByText(/Proof loaded from the product passport QR code/)).toBeVisible();
  await expect(page.locator("#proof-in")).toHaveValue(/"core"/);
});

test("Supplier: the Communication Template panel reads the Commission's example in the browser", async ({ page }) => {
  await page.goto("./#supplier");
  const panel = page.locator("details#template-import");
  await expect(panel).not.toHaveAttribute("open");
  await panel.locator("summary").click();
  await page.getByRole("button", { name: "Load the Commission's example" }).click();
  const table = panel.getByRole("table", { name: "Template value to credential field" });
  await expect(table).toBeVisible();
  await expect(table.getByRole("row", { name: /CN code 73181542 F26/ })).toBeVisible();
  await expect(table.getByRole("row", { name: /Emissions intensity \(tCO2e\/t\) 2\.00694 I26/ })).toBeVisible();
  await expect(panel.getByText("Still to be supplied by the supplier (6)")).toBeVisible();
  await expect(panel.getByText("Still to be supplied by the verification body (9)")).toBeVisible();
  await expect(panel.getByText(/^Supplier LEI — no cell in the Communication Template$/)).toBeVisible();
  await expect(panel.getByText(/© European Union, CC BY 4\.0 \(file renamed\); see SOURCE\.md/)).toBeVisible();
  const licences = await page.request.get(await panel.getByRole("link", { name: "third-party licenses" }).getAttribute("href") ?? "");
  expect(licences.ok()).toBe(true);
  expect(await licences.text()).toMatch(/exceljs [\d.]+ \(MIT\)[\s\S]*jszip [\d.]+[\s\S]*fflate [\d.]+ \(MIT\)/);
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // Long unbroken strings (file name, installation and product names) wrap at 390 px instead of widening the page.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(new URL("../../fixtures/cbam-template/CBAM_SEE_V2.1_Example_Steel_3_Screws_and_nuts.xlsx", import.meta.url).pathname);
  const sc = wb.getWorksheet("Summary_Communication")!;
  const long = "X".repeat(160);
  for (const ref of ["G12", "H26", "H27"]) sc.getCell(ref).value = { formula: "X", result: long } as ExcelJS.CellFormulaValue;
  await panel.locator('input[type="file"]').setInputFiles({
    name: `${"Long_file_name_".repeat(8)}.xlsx`,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(await wb.xlsx.writeBuffer()),
  });
  await expect(panel.getByTestId("template-summary")).toContainText(long);
  const overflowLong = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflowLong).toBeLessThanOrEqual(0);
  // Files above 20 MB are refused from File.size, before they are read.
  await panel.locator('input[type="file"]').setInputFiles({
    name: "too-large.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.alloc(20 * 1024 * 1024 + 1),
  });
  await expect(panel.getByRole("alert")).toHaveText(/Could not read too-large\.xlsx: file larger than 20971520 bytes .*it was not read/);
});

/** The offline (cached) view: every RPC blocked, then "Show cached results". */
async function offlineView(page: Page) {
  const data = await (await page.request.get("demo-data.json")).json();
  test.skip(!data.cached, "no cached snapshot in this demo data");
  for (const r of data.network.rpcs as string[]) await page.route(`${r}**`, (x) => x.abort());
  await page.goto("./#buyer");
  await page.getByRole("button", { name: /Show cached results/ }).click();
  await expect(page.getByText(/Offline view — cached on/)).toBeVisible();
  return data;
}

test("Offline view: the cached result only for the demo proof itself; Tamper is rejected by check 2 in the browser", async ({ page }) => {
  await offlineView(page);
  await page.getByRole("button", { name: "Load the demo proof" }).click();
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.locator(".stamp.green")).toHaveText("Verified");
  await expect(page.getByText(/Offline view: the result recorded for the demo proof on/)).toBeVisible();

  await page.getByRole("button", { name: "Tamper with one number" }).click();
  await expect(page.getByText("Disclosed intensity changed from 1.8 to 1.2.")).toBeVisible();
  await expect(page.locator(".stamp")).toHaveText("Rejected");
  await expect(page.locator(".stamp.green")).toHaveCount(0);
  await expect(page.locator("ol.checks > li").nth(1).locator(".badge")).toHaveText("✕ Failed");
  await expect(page.locator(".verify-summary")).toContainText("Rejected — check 2 failed");
  await expect(page.getByRole("button", { name: "Accept verified value" })).toBeDisabled();
  await expect(page.getByText("Offline view: checks 0–3 were recomputed in your browser; checks 4–8 need a live connection and were not run.")).toBeVisible();
});

test("Offline view: pasted JSON that is not the demo proof is never Verified; a valid proof in another layout is Not verified", async ({ page }) => {
  const data = await offlineView(page);
  const box = page.locator("#proof-in");
  const accept = page.getByRole("button", { name: "Accept verified value" });

  await box.fill('{"core":"{}","note":"not a proof at all"}');
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.locator(".stamp")).toHaveText("Rejected");
  await expect(page.locator(".stamp.green")).toHaveCount(0);
  await expect(accept).toBeDisabled();
  await expect(page.getByRole("button", { name: /Download verification record/ })).toHaveCount(0);

  // The demo proof, compact instead of indented: not the cached text, so checks 0-3 run here and 4-8 are not run.
  await box.fill(JSON.stringify(data.proof));
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.locator(".stamp")).toHaveText("Not verified");
  await expect(page.locator(".stamp.green")).toHaveCount(0);
  const checks = page.locator("ol.checks > li");
  for (const i of [0, 1, 2]) await expect(checks.nth(i).locator(".badge")).toHaveText("✓ Passed");
  for (const i of [3, 4, 5, 6, 7]) await expect(checks.nth(i)).toContainText("not run: needs a live connection to the chain");
  await expect(page.locator(".verify-summary")).toContainText("Not verified — checks 4–8 were not run");
  await expect(page.locator("#comparison")).toContainText("No verified value: checks 4–8 were not run (offline view).");
  await expect(accept).toBeDisabled();
});

test("Buyer: editing the proof clears the result; the figures and the record come from the proof that was verified", async ({ page }) => {
  const data = await (await page.request.get("demo-data.json")).json();
  await page.goto("./#buyer");
  await page.getByRole("button", { name: "Load the demo proof" }).click();
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  const accept = page.getByRole("button", { name: "Accept verified value" });
  await expect(page.locator(".stamp")).toBeVisible({ timeout: 60_000 });
  test.skip((await page.locator(".stamp").textContent()) !== "Verified", "the live demo proof is not VALID right now");
  // The demo proof's own values: the disclosed intensity 1.8 and the shipment's 200 t confirmed by check 5.
  const card = page.locator("#comparison");
  await expect(card.locator(".compare .v").nth(1)).toHaveText(`${data.comparison.verifiedValue} tCO2e/t`);
  // The same line as before the figures came from the proof (the video shows it).
  const c = data.comparison;
  const q = Number(c.quantityTonnes);
  const gap = Number(c.defaultValue) * q - Number(c.verifiedValue) * q;
  const f = (n: number, d = 1) => n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: d });
  await expect(page.locator(".verify-summary")).toHaveText(
    `✓ 8 of 8 checks passed · declared-emissions gap for this ${f(q)} t shipment: ${f(gap)} tCO2e (gross, illustrative) See comparison ↓`,
  );
  // Check 7 judges the auditor's authority at registration from the allowlist, like check 4.
  await expect(page.getByText(/Checks 4 and 7 both judge authority at registration time/)).toBeVisible();
  await accept.click();
  await expect(page.getByText(`for batch ${data.proof.shipment.batchId}`)).toBeVisible();

  // One character more in the box: the result, the stamp and the accepted value are gone until Verify is pressed again.
  await page.locator("#proof-in").press("End");
  await page.locator("#proof-in").pressSequentially(" ");
  await expect(page.locator(".stamp")).toHaveCount(0);
  await expect(page.locator(".verify-summary")).toHaveCount(0);
  await expect(accept).toBeDisabled();
  await expect(page.getByText(/Accepted \(demo\)/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Download verification record/ })).toHaveCount(0);
});
