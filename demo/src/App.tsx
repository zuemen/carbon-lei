import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ChainReader } from "../../sdk/chain.ts";
import { comparisonFigures, EVIDENCE_WHY, fmt, loadDemoData, type DemoData } from "./data.ts";
import { kgToT } from "./messages.ts";

// Tabs and the chain client load on demand, so the first screen needs only the page shell.
const Buyer = lazy(() => import("./tabs/Buyer.tsx").then((m) => ({ default: m.Buyer })));
const Supplier = lazy(() => import("./tabs/Supplier.tsx").then((m) => ({ default: m.Supplier })));
const VerificationBody = lazy(() => import("./tabs/VerificationBody.tsx").then((m) => ({ default: m.VerificationBody })));
const Attacks = lazy(() => import("./tabs/Attacks.tsx").then((m) => ({ default: m.Attacks })));
const TrustChain = lazy(() => import("./tabs/TrustChain.tsx").then((m) => ({ default: m.TrustChain })));
const OnchainProof = lazy(() => import("./tabs/OnchainProof.tsx").then((m) => ({ default: m.OnchainProof })));

export const TABS = [
  { id: "verification-body", label: "Verification body", short: "Body" },
  { id: "supplier", label: "Supplier", short: "Supplier" },
  { id: "buyer", label: "Buyer", short: "Buyer" },
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

export type ConnState =
  | { kind: "connecting"; waited: number; switched: boolean }
  | { kind: "live"; rpc: string; switched: boolean }
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

export function App() {
  const [data, setData] = useState<DemoData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<TabId>(tabFromHash);
  const [conn, setConn] = useState<ConnState>({ kind: "connecting", waited: 0, switched: false });
  const [reader, setReader] = useState<ChainReader | null>(null);
  const [proofText, setProofTextRaw] = useState("");
  const [proofFromSupplier, setProofFromSupplier] = useState(false);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
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
    try {
      for (let i = 0; i < d.network.rpcs.length; i++) {
        const rpc = d.network.rpcs[i];
        if (i > 0) setConn((c) => (c.kind === "connecting" ? { ...c, switched: true } : c));
        if (await probe(rpc, 7000)) {
          if (attempt.current !== my) return;
          const ordered = [rpc, ...d.network.rpcs.filter((r) => r !== rpc)];
          const { ChainReader: Reader, SEPOLIA_CHAIN } = await import("../../sdk/chain.ts");
          if (attempt.current !== my) return;
          setReader(Reader.forRpc(d.deployment, ordered, d.network.chainId === 11155111 ? SEPOLIA_CHAIN : undefined));
          setConn({ kind: "live", rpc, switched: i > 0 });
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
    };
  }, [data, reader, conn, go, proofText, proofFromSupplier]);

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
          </div>
        </header>
        <Lead data={data} reader={reader} offline={conn.kind === "offline"} onTry={() => go("try-to-break-it", "attack-2b")} />
        <ConnectionLine conn={conn} onRetry={() => connect(data)} onCached={() => setConn({ kind: "offline" })} cachedDate={data.cached?.time} />
      </div>

      <nav className="tabbar" aria-label="Demo sections">
        <div className="wrap">
          <div className="tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls="panel"
                className="tab"
                onClick={() => go(t.id)}
              >
                <span className="long-label">{t.label}</span>
                <span className="short-label">{t.short}</span>
              </button>
            ))}
          </div>
          <div className="pathbar">
            <span className="pathbar-label">Main path:</span>
            {STEPS.map((s, i) => (
              <span key={s.n} className="step">
                {i > 0 && <span className="step-arrow" aria-hidden="true">→</span>}
                <button
                  className="step-go"
                  aria-current={stepIndex === i ? "step" : undefined}
                  aria-label={`Go to step ${s.n}: ${s.long}${stepIndex === i ? " (current step)" : ""}`}
                  onClick={() => go(s.tab)}
                >
                  <span className="long-label">{s.n} {s.long}</span>
                  <span className="short-label">{s.n} {s.short}</span>
                  {stepIndex === i && <span className="sr-only"> (current step)</span>}
                </button>
              </span>
            ))}
            {stepIndex < 0 && <span className="path-hint">Background reading. The demo itself is the three steps above.</span>}
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

      <main id="panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="wrap">
        <Suspense fallback={<p aria-live="polite">Loading…</p>}>
          {tab === "verification-body" && <VerificationBody />}
          {tab === "supplier" && <Supplier />}
          {tab === "buyer" && <Buyer />}
          {tab === "try-to-break-it" && <Attacks />}
          {tab === "trust-chain" && <TrustChain />}
          {tab === "on-chain-proof" && <OnchainProof />}
        </Suspense>
      </main>

      <footer className="wrap">
        <div className="footer">
          <span>All companies fictional. Emissions values illustrative — not official CBAM methodology.</span>
          <span>
            <a href="https://github.com/zuemen/carbon-lei">Source on GitHub</a>
          </span>
        </div>
      </footer>
    </AppContext.Provider>
  );
}

/**
 * First screen: what is at stake (same figures as the Buyer tab's comparison card), the tonnage ledger
 * refusing a double claim, the question the demo answers, and — smaller but still visible — that the
 * vLEI chain is checked against exported evidence.
 */
function Lead(props: { data: DemoData; reader: ChainReader | null; offline: boolean; onTry: () => void }) {
  const { data } = props;
  const [why, setWhy] = useState(false);
  const cmp = data.comparison;
  const f = comparisonFigures(cmp);
  return (
    <>
      <p className="stake">
        Declaring this supplier's verified {cmp.verifiedValue} tCO2e/t instead of the CBAM default of{" "}
        {cmp.defaultValue} tCO2e/t (with 2026 mark-up) means{" "}
        <strong className="stake-num">{fmt(f.gap)} tCO2e less declared</strong> on one {fmt(f.q)} t shipment{" "}
        <span className="stake-note">— illustrative, gross: a gap in what is declared, not a physical reduction.</span>
      </p>
      <LedgerStrip data={data} reader={props.reader} offline={props.offline} onTry={props.onTry} />
      <p className="subtitle">
        Before an importer relies on that number: who signed it, were they authorised, and were these tonnes already
        claimed?
      </p>
      <p className="readonly-note">
        Read-only, no wallet needed · on-chain checks live on Sepolia · vLEI chain: exported evidence (
        {data.exportDate}), not live —{" "}
        <button
          type="button"
          className="link-btn"
          aria-expanded={why}
          aria-controls="evidence-why"
          onClick={() => setWhy((w) => !w)}
        >
          why?
        </button>
      </p>
      <p id="evidence-why" className="why-note" hidden={!why}>
        {EVIDENCE_WHY}
      </p>
    </>
  );
}

const tonnesToKg = (t: string) => BigInt(Math.round(Number(t) * 1000));

/**
 * One line under the stake: the report's verified tonnes, what is claimed and what is left, and the second
 * importer's claim that the contract refuses (Try to break it, card 2b). Same source as the Supplier tab's
 * ledger: the live contract once connected, the cached snapshot in the offline view; until then the
 * snapshot recorded when the demo data was built (or, without one, the demo shipment).
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
    <p className="ledger-strip">
      <span className="ledger-tag">Ledger</span>{" "}
      <span className="ledger-fig">
        <strong className="ledger-verified">{kgToT(verifiedKg)}</strong> t verified
      </span>{" "}
      {sep}
      <span className="ledger-fig">
        <strong className="ledger-claimed">{kgToT(claimedKg)}</strong> t claimed
      </span>{" "}
      {sep}
      <span className="ledger-fig">
        <strong className="ledger-left">{kgToT(leftKg)}</strong> t left
      </span>
      {refused && (
        <>
          {" "}
          <span className="ledger-refusal">
            — a <strong className="ledger-second">{second}</strong>&nbsp;t claim for a second importer is{" "}
            <strong className="ledger-refused">refused</strong>.
          </span>
        </>
      )}{" "}
      <a
        className="ledger-try"
        href="#try-to-break-it"
        onClick={(e) => {
          e.preventDefault();
          props.onTry();
        }}
      >
        Try it (2b)<span aria-hidden="true"> →</span>
        <span className="sr-only"> on the Try to break it tab</span>
      </a>
    </p>
  );
}

function ConnectionLine(props: { conn: ConnState; onRetry: () => void; onCached: () => void; cachedDate?: string }) {
  const { conn } = props;
  if (conn.kind === "connecting") {
    return (
      <p className={`conn ${conn.switched ? "warn" : ""}`} role="status" aria-live="polite">
        {conn.switched ? "Primary node did not respond. Switched to backup node. " : ""}Connecting to Sepolia… waited{" "}
        {conn.waited} s
      </p>
    );
  }
  if (conn.kind === "live") {
    return (
      <p className={`conn ${conn.switched ? "warn" : ""}`} role="status">
        {conn.switched ? "Primary node did not respond. Switched to backup node." : "Connected to Sepolia."}
      </p>
    );
  }
  if (conn.kind === "failed") {
    return (
      <div className="banner" role="alert">
        <span>Could not reach Sepolia after {conn.waited} s. Check your network and retry.</span>
        <span className="btn-row">
          <button className="btn btn-ghost" onClick={props.onRetry}>
            Retry
          </button>
          {props.cachedDate && (
            <button className="btn btn-ghost" onClick={props.onCached}>
              Show cached results (from {props.cachedDate.slice(0, 10)})
            </button>
          )}
        </span>
      </div>
    );
  }
  return null;
}
