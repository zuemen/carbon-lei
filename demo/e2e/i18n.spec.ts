// 繁體中文 coverage of the first screen, the Buyer tab's head and data-source panel, the precursor and carbon price
// sections (check 9 and 10 details, re-check items, sources, footers), the Trust chain headings and the Try to break
// it results; and the pointers from the main path to the enterprise features (Importer workbench).
//
// "No leftover English" is checked as no run of three or more Latin words, after removing what stays English on
// purpose: elements marked lang="en" (titles, button names), code and hashes, and the fictional entity names from
// the demo data files. Identifiers (vLEI, KEL, SAID, CN, tCO2e, chain ID, eth_call, LEIs) are not prose words.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

async function scan(page: Page, label: string) {
  await page.evaluate(() => Promise.allSettled(document.getAnimations().map((a) => a.finished)));
  await page.evaluate(() => window.scrollTo(0, 0));
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  const report = violations.map((v) => `${v.impact} ${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(report, `axe on ${label}`).toEqual([]);
}

async function connected(page: Page) {
  await expect(page.getByText("已連線到 Sepolia。").or(page.getByText("已切換到備用節點。"))).toBeVisible();
}

/** Every `name` value in the demo data files: the fictional companies, bodies and roots, which keep their names. */
async function entityNames(page: Page): Promise<string[]> {
  const names = new Set<string>();
  const walk = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") {
      for (const [k, v] of Object.entries(x)) {
        if ((k === "name" || k === "supplierName") && typeof v === "string" && v.length > 3) names.add(v);
        walk(v);
      }
    }
  };
  for (const f of ["demo-data.json", "precursor-data.json", "carbonprice-data.json"]) walk(await (await page.request.get(f)).json());
  return [...names].sort((a, b) => b.length - a.length);
}

/** Runs of three or more Latin words left in `loc`, outside lang="en" elements, code, hashes and entity names. */
async function leftoverEnglish(loc: Locator, names: string[]): Promise<string[]> {
  return loc.evaluate((root, names) => {
    const c = root.cloneNode(true) as HTMLElement;
    c.querySelectorAll('[lang="en"], code, .hash').forEach((e) => e.remove());
    // Text nodes joined with a space, so adjacent elements never run together into one word.
    const parts: string[] = [];
    const walk = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) parts.push(n.textContent ?? "");
    let t = parts.join(" ");
    for (const n of names) t = t.split(n).join(" ");
    // A prose word has a lowercase letter after its first one; identifiers (LEI, CN, ZZZZ00…, DEMO-ACC-LIV) do not.
    return t.match(/\b[A-Za-z][a-z'’]+(?: [A-Za-z][a-z'’]+){2,}\b/g) ?? [];
  }, names);
}

test("L1 繁體中文 first screen: answers, button, helper, gap, read-only note and connection line are translated; Verify runs the checks", async ({ page }) => {
  const names = await entityNames(page);
  await page.goto("./?lang=zh-TW#supplier");
  const glance = page.getByRole("region", { name: "一覽" });
  await connected(page);
  const answers = glance.getByRole("list", { name: "這些檢查回答的問題" }).getByRole("listitem");
  await expect(answers.locator(".answer-q")).toHaveText(["誰簽署的", "是否獲授權", "剩餘噸數"]);
  await expect(glance.locator(".ledger-strip .answer-a")).toContainText(/經查證.*已申領.*剩餘/);
  await expect(glance.getByText("在買方分頁載入證明並執行八項檢查（檢查 9–10，即前驅物與碳價，於本機鏈上展示）。")).toBeVisible();
  await expect(glance.locator(".stake")).toContainText("任何經查證數值都有的申報排放差距（毛額，示意），不是實際減排");
  await glance.getByRole("button", { name: "為什麼？" }).click();
  await expect(glance.locator("#evidence-why")).toContainText("KERI 代理");
  expect(await leftoverEnglish(glance, names)).toEqual([]);
  await glance.getByRole("button", { name: "驗證示範證明" }).click();
  await expect(page.getByRole("tab", { name: "買方（進口商）" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".verify-summary")).toContainText(/8 項檢查中 \d 項通過/);
});

test("L2 繁體中文 Buyer: the tab head, the data-source panel and the pointer to the Importer workbench", async ({ page }) => {
  const names = await entityNames(page);
  await page.goto("./?lang=zh-TW#buyer");
  await expect(page.getByRole("heading", { name: "檢查供應商的證明" })).toBeVisible();
  expect(await leftoverEnglish(page.locator(".tab-head"), names)).toEqual([]);
  const sources = page.locator("#check-sources");
  await sources.locator("summary").click();
  await expect(sources.locator("summary")).toHaveText("每項檢查的資料從哪裡來");
  await expect(sources.locator("tbody tr")).toHaveCount(8);
  expect(await leftoverEnglish(sources, names)).toEqual([]);
  await connected(page);
  await page.getByRole("button", { name: "Load the demo proof" }).click();
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.locator(".overall .stamp")).toHaveText("已驗證");
  // Six lines (the demo proof and five fictional shipments), each from its own supplier: workbench-data.ts.
  const next = page.getByRole("button", { name: "下一步：在進口商工作台查看來自 6 家供應商的 6 批出貨 →" });
  await next.click();
  await expect(page.getByRole("tab", { name: "進口商工作台" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".path-hint")).toHaveText("給有多家供應商的進口商：以同樣的檢查建立整年度的規劃。主要流程：上方的三個步驟。");
  await expect(page.getByRole("heading", { name: "進口商工作台" })).toBeVisible();
});

test("L3 English: after Verify, the Buyer tab points to the Importer workbench; the workbench says it is for many suppliers", async ({ page }) => {
  await page.goto("./#buyer");
  await expect(page.getByText("Connected to Sepolia.").or(page.getByText("Switched to backup node."))).toBeVisible();
  await page.getByRole("button", { name: "Load the demo proof" }).click();
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.locator(".overall .stamp")).toHaveText("Verified");
  await page.getByRole("button", { name: "Next: see 6 shipments from 6 suppliers in the Importer workbench →" }).click();
  await expect(page.getByRole("tab", { name: "Importer workbench" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".path-hint")).toHaveText("For importers with many suppliers: a year's plan built on the same checks. Main path: the three steps above.");
  await page.goto("./#trust-chain");
  await expect(page.locator(".path-hint")).toHaveText("Background reading. The demo itself is the three steps above.");
});

test("L4 繁體中文 precursor and carbon price sections: check 9 and 10 details, re-check items, sources and footers; the two percentages explained", async ({ page }) => {
  const names = await entityNames(page);
  const cp = await (await page.request.get("carbonprice-data.json")).json();
  const r = cp.verification.carbonPrice;
  // 2.07 %: € per tonne emitted ÷ €82.32; 1.86 %: certificates removed ÷ certificates needed; 90 %: 1.125 × 1.44 ÷ 1.8.
  const perTonne = ((Number(r.eurPerTCO2e) / Number(cp.refPriceEur)) * 100).toFixed(2);
  const ofCerts = ((Number(cp.reductionCertificates) / Number(cp.shipment.obligationT)) * 100).toFixed(2);
  const share = ((Number(r.target.massPerTonne) * Number(r.target.seeCap)) / Number(cp.shipment.see) * 100).toFixed(0);
  expect([perTonne, ofCerts, share]).toEqual(["2.07", "1.86", "90"]);

  await page.goto("./#buyer");
  await expect(page.locator("#carbon-price").getByTestId("cp-two-pct")).toHaveText(
    "2.07 % per tonne of wire-rod emissions; 1.86 % of the screws' certificates, because the wire rod is 90 % of the 1.8.",
  );

  await page.goto("./?lang=zh-TW#buyer");
  const pc = page.locator("#precursor");
  await expect(pc.getByText("前驅物（線材）")).toBeVisible();
  await pc.getByRole("button", { name: "在此瀏覽器重新檢查鏈下部分" }).click();
  await expect(pc.locator("ul.pc-items > li")).toHaveCount(8);
  await expect(pc.locator(".pc-result")).toContainText("重新計算 0.18 + 1.62 = 1.8 tCO2e/t");
  await expect(pc).toContainText("由 scripts/precursor-local.ts 在本機 anvil 鏈");
  expect(await leftoverEnglish(pc, names)).toEqual([]);

  const sec = page.locator("#carbon-price");
  await expect(sec.getByTestId("cp-two-pct")).toHaveText("每噸線材排放是 2.07%；占螺絲憑證的 1.86%，因為線材占 1.8 的 90%。");
  await expect(sec.locator(".pc-result")).toContainText("2025 年的平均匯率");
  await sec.getByRole("button", { name: "在此瀏覽器重新檢查聲明" }).click();
  await expect(sec.locator("ul.pc-items > li")).toHaveCount(7);
  await expect(sec.locator(".cp-sources a")).toHaveCount(6);
  await expect(sec.locator(".cp-sources")).toContainText("碳費收費辦法");
  expect(await leftoverEnglish(sec, names)).toEqual([]);
  await scan(page, "Buyer (zh-TW), precursor and carbon price sections after both re-checks");
});

test("L5 繁體中文 Trust chain headings and Try to break it results", async ({ page }) => {
  const names = await entityNames(page);
  await page.goto("./?lang=zh-TW#trust-chain");
  await expect(page.getByRole("heading", { name: "誰有權簽署" })).toBeVisible();
  await expect(page.getByRole("region", { name: "憑證鏈" })).toBeVisible();
  await expect(page.getByRole("region", { name: "冒名者" }).getByText("不在鏈中")).toBeVisible();
  await expect(page.getByRole("region", { name: "誰寫入允許清單" })).toBeVisible();
  expect(await leftoverEnglish(page.locator(".tab-head"), names)).toEqual([]);

  await page.goto("./?lang=zh-TW#try-to-break-it");
  await connected(page);
  for (const name of ["Change one disclosed number", "Claim the same batch again", /^Claim [\d.]+ t more$/, "Verify the impostor's proof"]) {
    await page.getByRole("button", { name }).click();
  }
  // The attack cards' results (the "What if one layer were missing?" card below them stays in English).
  const results = page.getByRole("region", { name: "攻擊" }).locator(".attack-result");
  await expect(results.filter({ hasText: "檢查 2 未通過：某個已揭露的數值在供應商建立證明後遭到更改。" })).toHaveCount(1);
  await expect(results.filter({ hasText: "已退回：BatchAlreadyClaimed——此批次已被申領。" })).toHaveCount(1);
  await expect(results.filter({ hasText: /已退回：ExceedsVerifiedTonnage——這筆申領會超出經查證報告所涵蓋的噸數（剩餘 [\d.]+ t，申請 [\d.]+ t）。/ })).toHaveCount(1);
  await expect(results.filter({ hasText: "檢查 7 未通過：" })).toHaveCount(1);
  await expect(results.locator(".stamp").first()).toHaveText("已拒絕");
  for (let i = 0; i < (await results.count()); i++) {
    expect(await leftoverEnglish(results.nth(i), names), `attack result ${i + 1}`).toEqual([]);
  }
});
