import { createContext, type KeyboardEvent, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ChainReader } from "../../sdk/chain.ts";
import { comparisonFigures, EVIDENCE_WHY, EVIDENCE_WHY_ZH, fmt, kgToT, loadDemoData, type DemoData } from "./data.ts";
import { HTML_LANG, LANGS, type Lang, useLang, useStrings } from "./i18n.ts";

// Tabs and the chain client load on demand, so the first screen needs only the page shell.
const Buyer = lazy(() => import("./tabs/Buyer.tsx").then((m) => ({ default: m.Buyer })));
const Supplier = lazy(() => import("./tabs/Supplier.tsx").then((m) => ({ default: m.Supplier })));
const VerificationBody = lazy(() => import("./tabs/VerificationBody.tsx").then((m) => ({ default: m.VerificationBody })));
const Attacks = lazy(() => import("./tabs/Attacks.tsx").then((m) => ({ default: m.Attacks })));
const TrustChain = lazy(() => import("./tabs/TrustChain.tsx").then((m) => ({ default: m.TrustChain })));
const Workbench = lazy(() => import("./tabs/Workbench.tsx").then((m) => ({ default: m.Workbench })));
const OnchainProof = lazy(() => import("./tabs/OnchainProof.tsx").then((m) => ({ default: m.OnchainProof })));

export const TABS = [
  { id: "verification-body", label: "Verification body", short: "Body" },
  { id: "supplier", label: "Supplier", short: "Supplier" },
  { id: "buyer", label: "Buyer", short: "Buyer" },
  { id: "importer-workbench", label: "Importer workbench", short: "Workbench" },
  { id: "try-to-break-it", label: "Try to break it", short: "Break it" },
  { id: "trust-chain", label: "Trust chain", short: "Trust" },
  { id: "on-chain-proof", label: "On-chain proof", short: "Proof" },
] as const;
export type TabId = (typeof TABS)[number]["id"];

const STEPS: { n: number; tab: TabId; long: string; short: string }[] = [
  { n: 1, tab: "supplier", long: "Supplier claims a shipment", short: "Claim" },
  { n: 2, tab: "buyer", long: "Buyer checks the proof", short: "Check" },
  { n: 3, tab: "try-to-break-it", long: "Try to break it", short: "Break it" },
];

/** Tab bar, main path and first-screen explanation in Traditional Chinese (Taiwan); the English is in TABS and STEPS. */
const ZH_TAB: Record<TabId, { label: string; short: string }> = {
  "verification-body": { label: "驗證機構", short: "驗證機構" },
  supplier: { label: "供應商", short: "供應商" },
  buyer: { label: "買方（進口商）", short: "買方" },
  "importer-workbench": { label: "進口商工作台", short: "工作台" },
  "try-to-break-it": { label: "試著破解", short: "破解" },
  "trust-chain": { label: "信任鏈", short: "信任鏈" },
  "on-chain-proof": { label: "鏈上證明", short: "鏈上證明" },
};
const ZH_STEP: Record<number, { long: string; short: string }> = {
  1: { long: "供應商申領一批出貨", short: "申領" },
  2: { long: "買方檢查證明", short: "檢查" },
  3: { long: "試著破解", short: "破解" },
};
const SHELL = {
  en: {
    langGroup: "Language",
    mainPath: "Main path:",
    goToStep: (n: number, long: string, current: boolean) => `Go to step ${n}: ${long}${current ? " (current step)" : ""}`,
    currentStep: " (current step)",
    pathHint: "Background reading. The demo itself is the three steps above.",
    pathHintWorkbench: "For importers with many suppliers: a year's plan built on the same checks. Main path: the three steps above.",
    claim: "A carbon number is only as trustworthy as the person who signed it.",
    context:
      "The EU charges importers for the carbon emitted making steel, aluminium and other goods (CBAM). The charge depends on a verified emissions value: this checks who signed it and that it is not reused beyond its verified tonnes.",
    glance: "At a glance",
    answersLabel: "What the checks answer",
    whoSigned: "Who signed",
    signer: "Signer identified · vLEI credential",
    authorised: "Authorised",
    role: "Role at the registering block",
    roleNote: "checked by the contract when the report was registered",
    tonnesLeft: "Tonnes left",
    verified: "verified",
    claimed: "claimed",
    left: "left",
    refusedPre: "a ",
    refusedMid: " t claim is ",
    refused: "refused",
    tryIt: "Try it (2b)",
    tryItSr: " on the Try to break it tab",
    verifyDemo: "Verify the demo proof",
    verifyHelp: "Loads it on the Buyer tab and runs the eight checks (checks 9–10, precursor and carbon price, are shown on a local chain).",
    stake: (gap: string, q: string, v: string, d: string) =>
      `${gap} tCO2e on one ${q} t shipment (${v} verified vs the ${d} tCO2e/t CBAM default with 2026 mark-up): the declared-emissions gap any verified value has (gross, illustrative), not a physical reduction.`,
    readOnly: (date: string) => `Read-only, no wallet needed · on-chain checks live on Sepolia · vLEI chain: exported evidence (${date}), not live — `,
    why: "why?",
    conn: {
      switched: "Primary node did not respond. Switched to backup node.",
      connecting: (s: number) => `Connecting to Sepolia… waited ${s} s`,
      connected: "Connected to Sepolia.",
      failed: (s: number) => `Could not reach Sepolia after ${s} s. Check your network and retry.`,
      retry: "Retry",
      cached: (d: string) => `Show cached results (from ${d})`,
    },
  },
  "zh-TW": {
    langGroup: "語言",
    mainPath: "主要流程：",
    goToStep: (n: number, long: string, current: boolean) => `前往步驟 ${n}：${long}${current ? "（目前步驟）" : ""}`,
    currentStep: "（目前步驟）",
    pathHint: "背景資料。示範本身是上方的三個步驟。",
    pathHintWorkbench: "給有多家供應商的進口商：以同樣的檢查建立整年度的規劃。主要流程：上方的三個步驟。",
    claim: "一個碳排放數字有多可信，取決於簽署它的人。",
    context:
      "歐盟對進口商就鋼鐵、鋁及其他商品生產過程中排放的碳收費（CBAM）。費用取決於經驗證的排放值：本工具檢查是誰簽署了這個數值，並確認它不會被重複使用而超出經驗證的噸數。",
    glance: "一覽",
    answersLabel: "這些檢查回答的問題",
    whoSigned: "誰簽署的",
    signer: "已識別簽署者 · vLEI 憑證",
    authorised: "是否獲授權",
    role: "登記區塊當時的角色",
    roleNote: "報告登記時由合約檢查",
    tonnesLeft: "剩餘噸數",
    verified: "經查證",
    claimed: "已申領",
    left: "剩餘",
    refusedPre: "",
    refusedMid: " t 的申領會被",
    refused: "拒絕",
    tryIt: "試試看（2b）",
    tryItSr: "（在「試著破解」分頁）",
    verifyDemo: "驗證示範證明",
    verifyHelp: "在買方分頁載入證明並執行八項檢查（檢查 9–10，即前驅物與碳價，於本機鏈上展示）。",
    stake: (gap: string, q: string, v: string, d: string) =>
      `一批 ${q} t 出貨的 ${gap} tCO2e（經查證 ${v}，對照含 2026 年加成的 CBAM 預設值 ${d} tCO2e/t）：任何經查證數值都有的申報排放差距（毛額，示意），不是實際減排。`,
    readOnly: (date: string) => `唯讀，不需錢包 · 鏈上檢查即時讀取 Sepolia · vLEI 鏈：匯出的證據（${date}），非即時——`,
    why: "為什麼？",
    conn: {
      switched: "主要節點沒有回應，已切換到備用節點。",
      connecting: (s: number) => `正在連線到 Sepolia…已等待 ${s} 秒`,
      connected: "已連線到 Sepolia。",
      failed: (s: number) => `${s} 秒後仍無法連上 Sepolia。請檢查網路後重試。`,
      retry: "重試",
      cached: (d: string) => `顯示快取結果（${d}）`,
    },
  },
};

/** Step number of each main-path tab; on phones the tab row shows it instead of a second (main path) row. */
const STEP_OF: Partial<Record<TabId, number>> = Object.fromEntries(STEPS.map((s) => [s.tab, s.n]));

export type ConnState =
  | { kind: "connecting"; waited: number; switched: boolean }
  // `behind`: every node's latest block is older than the head-age limit (Verify refuses it); shown instead of Connected.
  | { kind: "live"; rpc: string; switched: boolean; behind?: string }
  | { kind: "failed"; waited: number }
  | { kind: "offline" };

interface Ctx {
  data: DemoData;
  reader: ChainReader | null;
  conn: ConnState;
  offline: boolean;
  /** Opens a tab; with `target`, scrolls to the element with that id and focuses it once the tab has rendered. */
  go: (tab: TabId, target?: string) => void;
  proofText: string;
  setProofText: (s: string, fromSupplier?: boolean) => void;
  proofFromSupplier: boolean;
  explorer: (kind: "tx" | "address", value: string) => string | null;
  /** Set by the first screen's "Verify the demo proof": the Buyer tab verifies the demo proof once it can. */
  demoVerify: boolean;
  setDemoVerify: (on: boolean) => void;
}

const AppContext = createContext<Ctx | null>(null);
export const useApp = () => {
  const c = useContext(AppContext);
  if (!c) throw new Error("no app context");
  return c;
};

/** Scrolls an element to just below the sticky tab bar (its height depends on the screen width). */
export function scrollBelowTabbar(el: HTMLElement) {
  const bar = document.querySelector(".tabbar")?.getBoundingClientRect().height ?? 0;
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - bar - 12, behavior: smooth ? "smooth" : "auto" });
}

function tabFromHash(): TabId {
  const h = window.location.hash.replace(/^#/, "").split("?")[0];
  return (TABS.find((t) => t.id === h)?.id ?? "buyer") as TabId;
}

/** One JSON-RPC call with a timeout; no client library needed for the first screen. */
async function probe(rpc: string, ms: number): Promise<boolean> {
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: ctrl.signal,
    });
    const body = (await res.json()) as { result?: string };
    return res.ok && typeof body.result === "string";
  } catch {
    return false;
  } finally {
    window.clearTimeout(t);
  }
}

/** "English | 繁體中文" in the masthead: two toggle buttons, each labelled in its own language. */
function LangSwitch() {
  const { lang, setLang } = useLang();
  const s = useStrings(SHELL);
  const names: Record<Lang, string> = { en: "English", "zh-TW": "繁體中文" };
  return (
    <div className="lang-switch" role="group" aria-label={s.langGroup}>
      {LANGS.map((l, i) => (
        <span key={l} className="lang-item">
          {i > 0 && (
            <span className="lang-sep" aria-hidden="true">
              |
            </span>
          )}
          <button type="button" className="lang-btn" lang={HTML_LANG[l]} aria-pressed={lang === l} onClick={() => setLang(l)}>
            {names[l]}
          </button>
        </span>
      ))}
    </div>
  );
}

export function App() {
  const { lang } = useLang();
  const s = SHELL[lang];
  const zh = lang === "zh-TW";
  const [data, setData] = useState<DemoData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<TabId>(tabFromHash);
  const [conn, setConn] = useState<ConnState>({ kind: "connecting", waited: 0, switched: false });
  const [reader, setReader] = useState<ChainReader | null>(null);
  const [proofText, setProofTextRaw] = useState("");
  const [proofFromSupplier, setProofFromSupplier] = useState(false);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const [demoVerify, setDemoVerify] = useState(false);
  const attempt = useRef(0);

  useEffect(() => {
    loadDemoData().then(setData, (e: Error) => setLoadError(e.message));
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const connect = useCallback(async (d: DemoData) => {
    const my = ++attempt.current;
    const started = Date.now();
    setConn({ kind: "connecting", waited: 0, switched: false });
    const timer = window.setInterval(() => {
      if (attempt.current !== my) return;
      setConn((c) => (c.kind === "connecting" ? { ...c, waited: Math.round((Date.now() - started) / 1000) } : c));
    }, 1000);
    // The chain module downloads while the first node is probed, not after.
    const chainP = import("../../sdk/chain.ts");
    chainP.catch(() => {});
    try {
      for (let i = 0; i < d.network.rpcs.length; i++) {
        const rpc = d.network.rpcs[i];
        if (i > 0) setConn((c) => (c.kind === "connecting" ? { ...c, switched: true } : c));
        if (await probe(rpc, 7000)) {
          if (attempt.current !== my) return;
          const ordered = [rpc, ...d.network.rpcs.filter((r) => r !== rpc)];
          // The reader is handed to the tabs at once, so a waiting Verify starts now (it reads and checks the head
          // itself); the status line says Connected, or that every node's head is too old, once that is known.
          const r = (await chainP).ChainReader.pageReader(d.deployment, ordered);
          if (attempt.current !== my) return;
          setReader(r);
          const behind = (await r.headBehind(4000))?.text;
          if (attempt.current !== my) return;
          setConn({ kind: "live", rpc, switched: i > 0, behind });
          return;
        }
      }
      if (attempt.current === my) setConn({ kind: "failed", waited: Math.round((Date.now() - started) / 1000) });
    } finally {
      window.clearInterval(timer);
    }
  }, []);

  useEffect(() => {
    if (data) void connect(data);
  }, [data, connect]);

  const go = useCallback((t: TabId, target?: string) => {
    window.location.hash = t;
    setTab(t);
    if (target) setFocusTarget(target);
    else window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  // Tabs load on demand: wait (up to about five seconds) for the target to render, then scroll to it and focus it.
  useEffect(() => {
    if (!focusTarget) return;
    let frames = 0;
    let raf = 0;
    const tick = () => {
      const el = document.getElementById(focusTarget);
      if (el) {
        scrollBelowTabbar(el);
        el.focus({ preventScroll: true });
        setFocusTarget(null);
      } else if (++frames < 300) raf = window.requestAnimationFrame(tick);
      else setFocusTarget(null);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [focusTarget, tab]);

  // The sticky tab bar's height, as --tabbar-h: scroll-padding-top keeps anything scrolled into view (by focus,
  // by scrollIntoView) clear of the bar instead of under it.
  const hasData = data !== null;
  useEffect(() => {
    const bar = document.querySelector<HTMLElement>(".tabbar");
    if (!bar) return;
    const set = () => document.documentElement.style.setProperty("--tabbar-h", `${Math.ceil(bar.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [hasData]);

  // On phones the tabs are one row that scrolls sideways: keep the selected tab in view.
  useEffect(() => {
    const el = document.getElementById(`tab-${tab}`);
    const row = el?.parentElement;
    if (!el || !row || row.scrollWidth <= row.clientWidth) return;
    const left = el.offsetLeft - row.offsetLeft;
    if (left < row.scrollLeft || left + el.offsetWidth > row.scrollLeft + row.clientWidth) {
      row.scrollLeft = Math.max(0, left - (row.clientWidth - el.offsetWidth) / 2);
    }
  }, [tab, hasData]);

  const ctx = useMemo<Ctx | null>(() => {
    if (!data) return null;
    return {
      data,
      reader,
      conn,
      offline: conn.kind === "offline",
      go,
      proofText,
      setProofText: (s, fromSupplier = false) => {
        setProofTextRaw(s);
        setProofFromSupplier(fromSupplier);
      },
      proofFromSupplier,
      explorer: (kind, value) => (data.network.explorer ? `${data.network.explorer}/${kind}/${value}` : null),
      demoVerify,
      setDemoVerify,
    };
  }, [data, reader, conn, go, proofText, proofFromSupplier, demoVerify]);

  if (loadError) {
    return (
      <div className="wrap">
        <p role="alert">Could not load the demo data: {loadError}</p>
      </div>
    );
  }
  if (!ctx || !data) {
    return (
      <div className="wrap">
        <p aria-live="polite">Loading the demo…</p>
      </div>
    );
  }

  const stepIndex = STEPS.findIndex((s) => s.tab === tab);
  // Tab list keys (WAI-ARIA tabs pattern, automatic activation): arrows move between tabs, Home and End jump to the ends.
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next =
      e.key === "ArrowRight" ? (i + 1) % TABS.length
      : e.key === "ArrowLeft" ? (i - 1 + TABS.length) % TABS.length
      : e.key === "Home" ? 0
      : e.key === "End" ? TABS.length - 1
      : -1;
    if (next < 0) return;
    e.preventDefault();
    go(TABS[next].id);
    document.getElementById(`tab-${TABS[next].id}`)?.focus();
  };
  return (
    <AppContext.Provider value={ctx}>
      <div className="wrap">
        <header className="masthead">
          <h1 className="wordmark">
            Carbon<span>LEI</span>
          </h1>
          <div className="masthead-meta">
            <span className="net-chip">
              {data.network.chainId === 11155111 ? "Sepolia — proof-of-stake testnet" : `Local chain ${data.network.chainId}`}
            </span>
            <a href="#on-chain-proof" onClick={(e) => (e.preventDefault(), go("on-chain-proof"))}>
              Contracts ↗
            </a>
            <LangSwitch />
          </div>
        </header>
        <section aria-label={s.glance}>
          <Lead
            data={data}
            reader={reader}
            offline={conn.kind === "offline"}
            onTry={() => go("try-to-break-it", "attack-2b")}
            onVerify={() => {
              setProofTextRaw(JSON.stringify(data.proof, null, 2));
              setProofFromSupplier(false);
              setDemoVerify(true);
              go("buyer", "proof-h");
            }}
          />
          <ConnectionLine conn={conn} onRetry={() => connect(data)} onCached={() => setConn({ kind: "offline" })} cachedDate={data.cached?.time} />
        </section>
      </div>

      <nav className="tabbar" aria-label="Demo sections">
        <div className="wrap">
          <div className="tabs" role="tablist" onKeyDown={onTabKey}>
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls="panel"
                tabIndex={tab === t.id ? 0 : -1}
                className="tab"
                onClick={() => go(t.id)}
              >
                <span className="long-label">{zh ? ZH_TAB[t.id].label : t.label}</span>
                <span className="short-label">
                  {STEP_OF[t.id] ? `${STEP_OF[t.id]} ` : ""}
                  {zh ? ZH_TAB[t.id].short : t.short}
                </span>
              </button>
            ))}
          </div>
          <div className="pathbar">
            <span className="pathbar-label">{s.mainPath}</span>
            {STEPS.map((st, i) => {
              const long = zh ? ZH_STEP[st.n].long : st.long;
              const short = zh ? ZH_STEP[st.n].short : st.short;
              return (
                <span key={st.n} className="step">
                  {i > 0 && <span className="step-arrow" aria-hidden="true">→</span>}
                  <button
                    className="step-go"
                    aria-current={stepIndex === i ? "step" : undefined}
                    aria-label={s.goToStep(st.n, long, stepIndex === i)}
                    onClick={() => go(st.tab)}
                  >
                    <span className="long-label">{st.n} {long}</span>
                    <span className="short-label">{st.n} {short}</span>
                    {stepIndex === i && <span className="sr-only">{s.currentStep}</span>}
                  </button>
                </span>
              );
            })}
            {stepIndex < 0 && <span className="path-hint">{tab === "importer-workbench" ? s.pathHintWorkbench : s.pathHint}</span>}
          </div>
        </div>
      </nav>

      {conn.kind === "offline" && data.cached && (
        <div className="wrap">
          <div className="banner" role="status">
            <span>
              Offline view — cached on {data.cached.time.slice(0, 10)} at block {data.cached.block}; on-chain checks are
              not live.
            </span>
            <button className="btn btn-ghost" onClick={() => connect(data)}>
              Retry
            </button>
          </div>
        </div>
      )}

      <main className="wrap">
        <div id="panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
          <Suspense fallback={<p aria-live="polite">Loading…</p>}>
            {tab === "verification-body" && <VerificationBody />}
            {tab === "supplier" && <Supplier />}
            {tab === "buyer" && <Buyer />}
            {tab === "importer-workbench" && <Workbench />}
            {tab === "try-to-break-it" && <Attacks />}
            {tab === "trust-chain" && <TrustChain />}
            {tab === "on-chain-proof" && <OnchainProof />}
          </Suspense>
        </div>
      </main>

      <footer className="wrap">
        <div className="footer">
          <span>All companies fictional. Emissions values illustrative — not official CBAM methodology.</span>
          <span>
            <a href="https://github.com/zuemen/carbon-lei/blob/main/docs/CLIMATE_IMPACT.md">Climate impact assessment</a>
            {" · "}
            <a href="https://github.com/zuemen/carbon-lei/blob/main/docs/SECURITY.md">Security model</a>
            {" · "}
            <a href="https://github.com/zuemen/carbon-lei">Source on GitHub</a>
          </span>
        </div>
      </footer>
    </AppContext.Provider>
  );
}

/**
 * First screen, in order of size: the claim, three answers (who signed, authorised, tonnes left; the last one
 * refusing a double claim), one button that runs the Buyer tab's checks on the demo proof, then — in body text —
 * the declared-emissions gap (true of any verified value, not CarbonLEI's contribution) and the evidence caveat.
 */
function Lead(props: { data: DemoData; reader: ChainReader | null; offline: boolean; onTry: () => void; onVerify: () => void }) {
  const { data } = props;
  const [why, setWhy] = useState(false);
  const cmp = data.comparison;
  const f = comparisonFigures(cmp);
  const body = data.trustChain.find((n) => n.id === "body")?.name;
  const s = useStrings(SHELL);
  const zh = useLang().lang === "zh-TW";
  return (
    <>
      <p className="claim">{s.claim}</p>
      <p className="context">{s.context}</p>
      <ul className="answers" aria-label={s.answersLabel}>
        <li className="answer">
          <span className="answer-q">{s.whoSigned}</span>
          <strong className="answer-a">{s.signer}</strong>
          {body && (
            <span className="answer-note" lang={zh ? "en" : undefined}>
              {body}
            </span>
          )}
        </li>
        <li className="answer">
          <span className="answer-q">{s.authorised}</span>
          <strong className="answer-a">{s.role}</strong>
          <span className="answer-note">{s.roleNote}</span>
        </li>
        <LedgerStrip data={data} reader={props.reader} offline={props.offline} onTry={props.onTry} />
      </ul>
      <p className="lead-go">
        <button type="button" className="btn" onClick={props.onVerify}>
          {s.verifyDemo}
        </button>{" "}
        <span className="answer-note">{s.verifyHelp}</span>
      </p>
      <p className="stake">{s.stake(fmt(f.gap), fmt(f.q), cmp.verifiedValue, cmp.defaultValue)}</p>
      <p className="readonly-note">
        {s.readOnly(data.exportDate)}
        <button
          type="button"
          className="link-btn"
          aria-expanded={why}
          aria-controls="evidence-why"
          onClick={() => setWhy((w) => !w)}
        >
          {s.why}
        </button>
      </p>
      <p id="evidence-why" className="why-note" hidden={!why}>
        {zh ? EVIDENCE_WHY_ZH : EVIDENCE_WHY}
      </p>
    </>
  );
}

const tonnesToKg = (t: string) => BigInt(Math.round(Number(t) * 1000));

/**
 * The third answer: the report's verified tonnes, what is claimed and what is left, and the second importer's
 * claim that the contract refuses (Try to break it, card 2b). Same source as the Supplier tab's ledger: the live
 * contract once connected, the cached snapshot in the offline view; until then the snapshot recorded when the
 * demo data was built (or, without one, the demo shipment).
 */
function LedgerStrip(props: { data: DemoData; reader: ChainReader | null; offline: boolean; onTry: () => void }) {
  const { data, reader, offline } = props;
  const verifiedKg = tonnesToKg(data.report.verifiedTonnes);
  const recordedKg = data.cached ? BigInt(data.cached.remainingKg) : verifiedKg - tonnesToKg(data.shipment.quantityTonnes);
  const [liveKg, setLiveKg] = useState<bigint | null>(null);

  useEffect(() => {
    if (offline || !reader) return;
    let live = true;
    reader.remainingKg(data.credential.reportKey).then(
      (kg) => live && setLiveKg(kg),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [reader, offline, data]);

  const s = useStrings(SHELL);
  const leftKg = !offline && liveKg !== null ? liveKg : recordedKg;
  const claimedKg = verifiedKg - leftKg;
  const second = data.attacks.secondImporter.quantityTonnes;
  const refused = tonnesToKg(second) > leftKg;
  const sep = (
    <>
      <span className="ledger-sep" aria-hidden="true">·</span>
      <span className="sr-only">,</span>{" "}
    </>
  );
  return (
    <li className="answer ledger-strip">
      <span className="answer-q">{s.tonnesLeft}</span>
      <strong className="answer-a">
        <span className="ledger-fig">
          <span className="ledger-verified">{kgToT(verifiedKg)}</span> {s.verified}
        </span>{" "}
        {sep}
        <span className="ledger-fig">
          <span className="ledger-claimed">{kgToT(claimedKg)}</span> {s.claimed}
        </span>{" "}
        {sep}
        <span className="ledger-fig">
          <span className="ledger-left">{kgToT(leftKg)}</span> {s.left}
        </span>
      </strong>
      <span className="answer-note">
        {refused && (
          <>
            <span className="ledger-refusal">
              {s.refusedPre}
              <span className="ledger-second">{second}</span>
              {s.refusedMid.replace(/^ t/, " t")}
              <strong className="ledger-refused">{s.refused}</strong>
            </span>{" "}
            {sep}
          </>
        )}
        <a
          className="ledger-try"
          href="#try-to-break-it"
          onClick={(e) => {
            e.preventDefault();
            props.onTry();
          }}
        >
          {s.tryIt}
          <span aria-hidden="true"> →</span>
          <span className="sr-only">{s.tryItSr}</span>
        </a>
      </span>
    </li>
  );
}

function ConnectionLine(props: { conn: ConnState; onRetry: () => void; onCached: () => void; cachedDate?: string }) {
  const { conn } = props;
  const c = useStrings(SHELL).conn;
  if (conn.kind === "connecting") {
    return (
      <p className={`conn ${conn.switched ? "warn" : ""}`} role="status" aria-live="polite">
        {conn.switched ? `${c.switched} ` : ""}
        {c.connecting(conn.waited)}
      </p>
    );
  }
  if (conn.kind === "live") {
    return (
      <p className={`conn ${conn.switched || conn.behind ? "warn" : ""}`} role="status">
        {conn.behind ?? (conn.switched ? c.switched : c.connected)}
      </p>
    );
  }
  if (conn.kind === "failed") {
    return (
      <div className="banner" role="alert">
        <span>{c.failed(conn.waited)}</span>
        <span className="btn-row">
          <button className="btn btn-ghost" onClick={props.onRetry}>
            {c.retry}
          </button>
          {props.cachedDate && (
            <button className="btn btn-ghost" onClick={props.onCached}>
              {c.cached(props.cachedDate.slice(0, 10))}
            </button>
          )}
        </span>
      </div>
    );
  }
  return null;
}
