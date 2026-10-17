// Supplier portal, in the Supplier tab: one verified report shared with several buyers. The first row is the real
// Sepolia claim (read live); the others are fictional planned allocations that exist only in this browser. The
// reconciliation and the proofs come from sdk/allocation.ts, the same code as `carbonlei allocate` / `present-batch`.
import { useEffect, useMemo, useState } from "react";
import { keccak256, stringToBytes } from "viem";
import {
  buildSharePack,
  DISCLOSURE_PRESETS,
  readAllocationSnapshot,
  reconcile,
  type AllocationBook,
  type AllocationSnapshot,
  type BatchState,
  type ReportRef,
} from "../../../sdk/allocation.ts";
import { batchKeyOf, importerCommitOf, ZERO32 } from "../../../sdk/commitment.ts";
import { tonnesToKg, type Hex } from "../../../sdk/credential.ts";
import { decodeDisclosure } from "../../../sdk/disclosure.ts";
import type { SignedCredential } from "../../../sdk/issue.ts";
import { useApp } from "../App.tsx";
import { Badge } from "../components.tsx";
import { kgToT } from "../data.ts";
import { useLang, type Lang } from "../i18n.ts";
import "../allocations.css";

// The presets come from the SDK: each one still verifies VALID (sdk/test/disclosure-presets.test.ts). "minimal"
// keeps every field check 8 reconciles, since the credential commits to a signed reconciliation.
type Profile = keyof typeof DISCLOSURE_PRESETS;
const PROFILE_FIELDS: Record<Profile, readonly string[]> = DISCLOSURE_PRESETS;

/** Fictional planned buyers: in this browser only, never on-chain. Salts are fixed so the page is reproducible. */
const PLANNED = [
  { id: "demo-schrauben", batchId: "BATCH-DEMO-2026-0002", tonnes: "400", date: "2026-11-05", profile: "importer" as Profile },
  { id: "demo-nordic", batchId: "BATCH-DEMO-2026-0003", tonnes: "80", date: "2026-11-20", profile: "minimal" as Profile },
];
const NORDIC = { name: "Demo Nordic Fasteners AB (fictional)", eori: "SEDEMO000000003" };
const plannedSalt = (id: string): Hex => keccak256(stringToBytes(`carbonlei-demo-planned:${id}`));

const TXT = {
  en: {
    kicker: "Allocations — one verified report, many buyers",
    lede: "Every EU customer asks the same supplier for the same data. Here the supplier answers each buyer from one verified report: the tonnes go to buyers through the shared ledger, and each buyer gets its own proof with its own fields.",
    caption: "Allocation book of report",
    buyer: "Buyer",
    batch: "Batch",
    quantity: "Quantity (t)",
    status: "Status",
    fields: "Fields",
    qtyLabel: (b: string) => `Planned quantity in tonnes for ${b}`,
    fieldsLabel: (b: string) => `Fields for ${b}`,
    profile: { importer: "Importer set (CBAM)", minimal: "Minimal that still verifies" } as Record<Profile, string>,
    state: {
      claimed: "On-chain claim (Sepolia)",
      mismatch: "On-chain, differs from the book",
      missing: "Claim not found",
      planned: "Planned, not on-chain",
      "over-allocated": "Would be refused",
      blocked: "Report takes no claims",
    } as Record<BatchState, string>,
    live: (b: string) => `Read live from Sepolia at block ${b}.`,
    cached: (b: string) => `Cached snapshot from block ${b} (offline view).`,
    reading: "Reading the claim from Sepolia…",
    readFail: "Could not read Sepolia; the table uses the recorded values.",
    summary: (v: string, c: string, r: string, p: string, x: string) =>
      `Verified ${v} t · claimed on-chain ${c} t · remaining ${r} t · planned that fits ${p} t${x !== "0" ? ` · would be refused ${x} t` : ""}`,
    warn: (batch: string, q: string, left: string) =>
      `Planned allocations exceed the remaining tonnes: ${batch} asks for ${q} t but only ${left} t are left. The contract would refuse this claim (ExceedsVerifiedTonnage) — the same refusal as attack 2b.`,
    seeAttack: "See attack 2b",
    fits: "All planned allocations fit in the remaining tonnes.",
    dryRun: "Check each planned row with the contract (eth_call, no transaction)",
    dryRunNote: "Each row is simulated alone against the current ledger, as the supplier's wallet.",
    dryOk: "eth_call: accepted",
    dryRefused: (left: string, asked: string) => `eth_call: refused — ExceedsVerifiedTonnage (${left} t left, ${asked} t asked)`,
    dryOther: (name: string) => `eth_call: refused — ${name}`,
    dryOffline: "The contract check needs a live connection.",
    make: "Make proofs for all buyers",
    proofsH: "Proofs, one per buyer",
    download: (f: string) => `Download ${f}`,
    nFields: (n: number) => `${n} fields`,
    readyNow: "verifies now for this buyer's EORI",
    afterClaim: "verifies only after the claim is sent; until then check 5 fails",
    noProof: "no proof: the contract would refuse this claim",
    noProofIncomplete: "no proof: these fields hide what check 8 needs, so the buyer's verifier would return Not verified (INCOMPLETE)",
    open: "Open in the Buyer tab →",
    fine: "Rows 2 and 3 and their importers are fictional and exist only in this browser; only row 1 is on-chain. EORIs and salts stay with the supplier: the chain holds commitments only. Same code as the CLI: carbonlei allocate and carbonlei present-batch.",
  },
  "zh-TW": {
    kicker: "分配——一份經驗證報告，多位買方",
    lede: "每一位歐盟客戶都向同一家供應商索取同樣的資料。這裡供應商以一份經驗證報告回覆每一位買方：噸數透過共享帳本分配給各買方，每位買方各自取得一份只含其所需欄位的證明。",
    caption: "分配帳簿，報告",
    buyer: "買方",
    batch: "批次",
    quantity: "數量（噸）",
    status: "狀態",
    fields: "欄位",
    qtyLabel: (b: string) => `${b} 的計畫數量（噸）`,
    fieldsLabel: (b: string) => `${b} 可看到的欄位`,
    profile: { importer: "進口商組合（CBAM）", minimal: "最少欄位（仍可驗證通過）" } as Record<Profile, string>,
    state: {
      claimed: "鏈上申領（Sepolia）",
      mismatch: "鏈上紀錄與帳簿不符",
      missing: "查無申領",
      planned: "計畫中，尚未上鏈",
      "over-allocated": "將被拒絕",
      blocked: "報告不再接受申領",
    } as Record<BatchState, string>,
    live: (b: string) => `於區塊 ${b} 即時讀取 Sepolia。`,
    cached: (b: string) => `區塊 ${b} 的快取快照（離線檢視）。`,
    reading: "正在從 Sepolia 讀取申領紀錄…",
    readFail: "無法讀取 Sepolia；表格使用已記錄的數值。",
    summary: (v: string, c: string, r: string, p: string, x: string) =>
      `經驗證 ${v} 噸 · 鏈上已申領 ${c} 噸 · 剩餘 ${r} 噸 · 可容納的計畫 ${p} 噸${x !== "0" ? ` · 將被拒絕 ${x} 噸` : ""}`,
    warn: (batch: string, q: string, left: string) =>
      `計畫分配超過剩餘噸數：${batch} 要求 ${q} 噸，但只剩 ${left} 噸。合約會拒絕這筆申領（ExceedsVerifiedTonnage）——與攻擊 2b 相同的拒絕。`,
    seeAttack: "查看攻擊 2b",
    fits: "所有計畫分配都在剩餘噸數之內。",
    dryRun: "以合約逐列檢查計畫（eth_call，不送出交易）",
    dryRunNote: "每一列都以供應商錢包的身分，對目前帳本單獨模擬。",
    dryOk: "eth_call：接受",
    dryRefused: (left: string, asked: string) => `eth_call：拒絕——ExceedsVerifiedTonnage（剩 ${left} 噸，要求 ${asked} 噸）`,
    dryOther: (name: string) => `eth_call：拒絕——${name}`,
    dryOffline: "合約檢查需要即時連線。",
    make: "為所有買方產生證明",
    proofsH: "證明，每位買方一份",
    download: (f: string) => `下載 ${f}`,
    nFields: (n: number) => `${n} 個欄位`,
    readyNow: "現在即可對此買方的 EORI 驗證通過",
    afterClaim: "須先送出申領才能驗證；在此之前檢查 5 不會通過",
    noProof: "不產生證明：合約會拒絕這筆申領",
    noProofIncomplete: "不產生證明：這組欄位隱藏了檢查 8 需要的欄位，買方的驗證器將回傳「未驗證（INCOMPLETE）」",
    open: "在買方分頁開啟 →",
    fine: "第 2、3 列及其進口商皆為虛構，只存在於此瀏覽器；只有第 1 列在鏈上。EORI 與鹽值留在供應商手中：鏈上只有承諾值。與 CLI 相同的程式碼：carbonlei allocate 與 carbonlei present-batch。",
  },
} satisfies Record<Lang, unknown>;

export function Allocations() {
  const { lang } = useLang();
  const t = TXT[lang];
  const { data, reader, offline, setProofText, go } = useApp();
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(PLANNED.map((p) => [p.id, p.tonnes])));
  const [profiles, setProfiles] = useState<Record<string, Profile>>(() => ({
    "demo-imports": "importer",
    ...Object.fromEntries(PLANNED.map((p) => [p.id, p.profile])),
  }));
  const [snap, setSnap] = useState<AllocationSnapshot | null>(null);
  const [source, setSource] = useState<"live" | "cached" | "failed" | null>(null);
  const [dry, setDry] = useState<Record<string, string> | null>(null);
  const [pack, setPack] = useState<{ id: string; name: string; batchId: string; file: string; n: number; url: string; text: string; ready: boolean }[] | null>(null);
  // Batches buildSharePack refused because their fields hide one check 8 needs (none with the SDK presets).
  const [incomplete, setIncomplete] = useState<Set<string>>(new Set());

  const core = useMemo(() => JSON.parse(data.credential.coreJson) as { d: string }, [data]);
  const ref: ReportRef = useMemo(
    () => ({ credSAID: core.d, batchSalt: decodeDisclosure(data.credential.disclosures.batchSalt).value as Hex }),
    [core, data],
  );

  const book: AllocationBook = useMemo(() => {
    const valid = (s: string) => {
      try {
        tonnesToKg(s);
        return s;
      } catch {
        return "1";
      }
    };
    return {
      version: 1,
      importers: [
        { id: "demo-imports", name: data.importer.name, eori: data.importer.eori, fields: [...PROFILE_FIELDS[profiles["demo-imports"]]] },
        { id: "demo-schrauben", name: data.secondImporter.name, eori: data.secondImporter.eori, fields: [...PROFILE_FIELDS[profiles["demo-schrauben"]]] },
        { id: "demo-nordic", name: NORDIC.name, eori: NORDIC.eori, fields: [...PROFILE_FIELDS[profiles["demo-nordic"]]] },
      ],
      batches: [
        { batchId: data.shipment.batchId, importer: "demo-imports", importerSalt: data.shipment.importerSalt, quantityTonnes: data.shipment.quantityTonnes, shipmentDate: data.shipment.shipmentDate, status: "claimed" },
        ...PLANNED.map((p) => ({ batchId: p.batchId, importer: p.id, importerSalt: plannedSalt(p.id), quantityTonnes: valid(qty[p.id]), shipmentDate: p.date, status: "planned" as const })),
      ],
    };
  }, [data, qty, profiles]);

  // The snapshot depends only on the batch keys (not on the quantities typed in): read once per connection.
  useEffect(() => {
    let live = true;
    if (offline && data.cached) {
      const c = data.cached;
      const verifiedKg = tonnesToKg(data.report.verifiedTonnes);
      const shipments: AllocationSnapshot["shipments"] = {};
      for (const b of book.batches) shipments[batchKeyOf(data.credential.reportKey, b.batchId, ref.batchSalt)] = { reportKey: ZERO32, quantityKg: 0n, importerCommit: ZERO32, claimedAt: 0n, reportValid: false };
      shipments[batchKeyOf(data.credential.reportKey, data.shipment.batchId, ref.batchSalt)] = {
        reportKey: data.credential.reportKey,
        quantityKg: BigInt(c.shipment.quantityKg),
        importerCommit: importerCommitOf(data.importer.eori, data.shipment.importerSalt),
        claimedAt: BigInt(c.shipment.claimedAt),
        reportValid: c.shipment.reportValid,
      };
      setSnap({
        blockNumber: BigInt(c.block),
        blockTime: BigInt(Math.floor(Date.parse(c.time) / 1000)),
        reportKey: data.credential.reportKey,
        report: { verifiedKg, registeredAt: 1n, revokedAt: 0n, supersededBy: ZERO32, validUntil: 2n ** 63n },
        claimable: c.reportValid,
        remainingKg: BigInt(c.remainingKg),
        ledgerClaimedKg: verifiedKg - BigInt(c.remainingKg),
        shipments,
      });
      setSource("cached");
      return;
    }
    if (!reader) return;
    readAllocationSnapshot(reader, book, ref).then(
      (s) => {
        if (!live) return;
        setSnap(s);
        setSource("live");
      },
      () => live && setSource("failed"),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- batch keys do not change with the typed quantities
  }, [reader, offline, data, ref]);

  const report = useMemo(() => (snap ? reconcile(book, ref, snap) : null), [book, ref, snap]);

  useEffect(() => () => pack?.forEach((p) => URL.revokeObjectURL(p.url)), [pack]);

  const names = Object.fromEntries(book.importers.map((i) => [i.id, i.name ?? i.id]));
  const over = report?.batches.find((b) => b.state === "over-allocated");
  const leftBefore = (batchId: string) => {
    if (!report) return 0n;
    let left = report.report.remainingKg;
    for (const b of report.batches) {
      if (b.batchId === batchId) return left;
      if (b.state === "planned") left -= b.quantityKg;
    }
    return left;
  };

  async function dryRunAll() {
    if (!reader || !snap) return;
    const out: Record<string, string> = {};
    for (const b of book.batches.filter((x) => x.status === "planned")) {
      const im = book.importers.find((i) => i.id === b.importer)!;
      const args = [data.credential.reportKey, batchKeyOf(data.credential.reportKey, b.batchId, ref.batchSalt), tonnesToKg(b.quantityTonnes), importerCommitOf(im.eori, b.importerSalt)] as const;
      const r = await reader.dryRun("claimShipment", args, data.addresses.supplier);
      out[b.batchId] = !r.reverted
        ? t.dryOk
        : r.errorName === "ExceedsVerifiedTonnage"
          ? t.dryRefused(kgToT(r.args[0]), kgToT(r.args[1]))
          : t.dryOther(r.errorName);
    }
    setDry(out);
  }

  function makeProofs() {
    if (!report) return;
    pack?.forEach((p) => URL.revokeObjectURL(p.url));
    const cred = { core, coreJson: data.credential.coreJson, signature: data.credential.signature, disclosures: data.credential.disclosures } as unknown as SignedCredential;
    const refused = new Set(report.batches.filter((b) => b.state === "over-allocated" || b.state === "blocked").map((b) => b.batchId));
    const { proofs, skipped } = buildSharePack(cred, book, {
      includePlanned: true,
      only: (b) => !refused.has(b.batchId),
      evidence: {
        ...(data.proof.anchorEvidence ? { anchorEvidence: data.proof.anchorEvidence } : {}),
        ...(data.proof.authorityEvidence ? { authorityEvidence: data.proof.authorityEvidence } : {}),
        ...(data.proof.reportExtract ? { reportExtract: data.proof.reportExtract } : {}),
      },
    });
    setIncomplete(new Set(skipped.filter((k) => k.reason.startsWith("hides ")).map((k) => k.batchId)));
    setPack(
      proofs.map((p) => {
        const text = JSON.stringify(p.proof, null, 2);
        return {
          id: p.importer,
          name: names[p.importer],
          batchId: p.batchId,
          file: p.file,
          n: p.fields.length,
          text,
          url: URL.createObjectURL(new Blob([text], { type: "application/json" })),
          ready: report.batches.find((b) => b.batchId === p.batchId)?.state === "claimed",
        };
      }),
    );
  }

  const badge = (s: BatchState) => (s === "claimed" ? "pass" : s === "planned" ? "idle" : s === "over-allocated" || s === "blocked" ? "fail" : "review");

  return (
    <section className="sheet reveal alloc" aria-labelledby="alloc-h" style={{ marginTop: 28 }}>
      <h3 className="sheet-kicker" id="alloc-h">
        {t.kicker}
      </h3>
      <p className="alloc-lede">{t.lede}</p>
      <p className="fine" aria-live="polite">
        {source === "live" && snap ? t.live(snap.blockNumber.toString()) : source === "cached" && snap ? t.cached(snap.blockNumber.toString()) : source === "failed" ? t.readFail : t.reading}
      </p>
      {report && (
        <>
          <p className="alloc-summary">
            {t.summary(kgToT(report.report.verifiedKg), kgToT(report.report.ledgerClaimedKg), kgToT(report.report.remainingKg), kgToT(report.totals.plannedKg), kgToT(report.totals.refusedKg))}
          </p>
          <div className="table-wrap">
            <table className="ledger alloc-table">
              <caption className="sr-only">
                {t.caption} {data.report.reportId}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t.buyer}</th>
                  <th scope="col">{t.batch}</th>
                  <th scope="col">{t.quantity}</th>
                  <th scope="col">{t.status}</th>
                  <th scope="col">{t.fields}</th>
                </tr>
              </thead>
              <tbody>
                {report.batches.map((b) => {
                  const plannedRow = book.batches.find((x) => x.batchId === b.batchId)!.status === "planned";
                  const who = names[b.importer];
                  return (
                    <tr key={b.batchId} data-state={b.state}>
                      <td data-label={t.buyer}>{who}</td>
                      <td data-label={t.batch}>{b.batchId}</td>
                      <td data-label={t.quantity}>
                        {plannedRow ? (
                          <input
                            className="alloc-qty"
                            type="number"
                            inputMode="decimal"
                            min={1}
                            step={1}
                            value={qty[b.importer]}
                            aria-label={t.qtyLabel(who)}
                            onChange={(e) => {
                              setQty({ ...qty, [b.importer]: e.target.value });
                              setDry(null);
                              setPack(null);
                            }}
                          />
                        ) : (
                          kgToT(b.quantityKg)
                        )}
                      </td>
                      <td data-label={t.status}>
                        <Badge kind={badge(b.state)}>{t.state[b.state]}</Badge>
                        {dry?.[b.batchId] && <span className="alloc-dry">{dry[b.batchId]}</span>}
                      </td>
                      <td data-label={t.fields}>
                        <select
                          className="alloc-profile"
                          value={profiles[b.importer]}
                          aria-label={t.fieldsLabel(who)}
                          onChange={(e) => {
                            setProfiles({ ...profiles, [b.importer]: e.target.value as Profile });
                            setPack(null);
                          }}
                        >
                          {(Object.keys(PROFILE_FIELDS) as Profile[]).map((p) => (
                            <option key={p} value={p}>
                              {t.profile[p]} · {PROFILE_FIELDS[p].length}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div role="status" className={over ? "alloc-warn" : "alloc-ok"}>
            {over ? (
              <>
                {t.warn(over.batchId, kgToT(over.quantityKg), kgToT(leftBefore(over.batchId)))}{" "}
                <button className="link-btn" onClick={() => go("try-to-break-it", "attack-2b")}>
                  {t.seeAttack}
                </button>
              </>
            ) : (
              t.fits
            )}
          </div>
          <div className="btn-row" style={{ marginTop: 14 }}>
            <button className="btn btn-ghost" onClick={dryRunAll} disabled={!reader || offline}>
              {t.dryRun}
            </button>
            <button className="btn" onClick={makeProofs}>
              {t.make}
            </button>
          </div>
          <p className="fine">{!reader || offline ? t.dryOffline : t.dryRunNote}</p>
          {pack && (
            <div className="alloc-pack">
              <h4 className="alloc-pack-h">{t.proofsH}</h4>
              <ul>
                {report.batches.map((b) => {
                  const p = pack.find((x) => x.batchId === b.batchId);
                  return (
                    <li key={b.batchId}>
                      <strong>{names[b.importer]}</strong> · {b.batchId} ·{" "}
                      {p ? (
                        <>
                          {t.nFields(p.n)} · {p.ready ? t.readyNow : t.afterClaim}
                          <br />
                          <a href={p.url} download={p.file}>
                            {t.download(p.file)}
                          </a>
                          {p.ready && (
                            <>
                              {" "}
                              <button
                                className="link-btn"
                                onClick={() => {
                                  setProofText(p.text, true);
                                  go("buyer");
                                }}
                              >
                                {t.open}
                              </button>
                            </>
                          )}
                        </>
                      ) : incomplete.has(b.batchId) ? (
                        t.noProofIncomplete
                      ) : (
                        t.noProof
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}
      <p className="fine">{t.fine}</p>
    </section>
  );
}
