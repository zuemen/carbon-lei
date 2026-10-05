import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { ChainReader } from "../../sdk/chain.ts";
import { loadDemoData, type DemoData } from "./data.ts";
import { Buyer } from "./tabs/Buyer.tsx";
import { Supplier } from "./tabs/Supplier.tsx";
import { VerificationBody } from "./tabs/VerificationBody.tsx";
import { Attacks } from "./tabs/Attacks.tsx";
import { TrustChain } from "./tabs/TrustChain.tsx";
import { OnchainProof } from "./tabs/OnchainProof.tsx";

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
  go: (tab: TabId) => void;
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

function tabFromHash(): TabId {
  const h = window.location.hash.replace(/^#/, "").split("?")[0];
  return (TABS.find((t) => t.id === h)?.id ?? "buyer") as TabId;
}

async function probe(rpc: string, ms: number): Promise<boolean> {
  const client = createPublicClient({ transport: http(rpc, { timeout: ms, retryCount: 0 }) });
  try {
    await client.getBlockNumber();
    return true;
  } catch {
    return false;
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
          setReader(ChainReader.forRpc(d.deployment, ordered, d.network.chainId === 11155111 ? sepolia : undefined));
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

  const go = useCallback((t: TabId) => {
    window.location.hash = t;
    setTab(t);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

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
        <p className="subtitle">Who signed this carbon number, were they authorised, and has it been used?</p>
        <p className="readonly-note">
          Read-only demo — no wallet needed. On-chain checks run live against Sepolia in your browser. The vLEI
          credential chain is checked against evidence exported from a local KERI run on {data.exportDate} — KERI agents
          need a server we do not host here; run the local mode (README › Quick start) to check the chain live.
        </p>
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
            {stepIndex < 0 && <span className="path-hint">You are on a background tab. Pick a step to continue.</span>}
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
        {tab === "verification-body" && <VerificationBody />}
        {tab === "supplier" && <Supplier />}
        {tab === "buyer" && <Buyer />}
        {tab === "try-to-break-it" && <Attacks />}
        {tab === "trust-chain" && <TrustChain />}
        {tab === "on-chain-proof" && <OnchainProof />}
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
