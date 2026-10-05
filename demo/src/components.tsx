import type { ReactNode } from "react";
import { useApp } from "./App.tsx";
import { short } from "./data.ts";

export function TxLink({ hash, label }: { hash: string; label?: string }) {
  const { explorer } = useApp();
  const href = explorer("tx", hash);
  const text = label ?? short(hash);
  return href ? (
    <a className="hash" href={href} target="_blank" rel="noreferrer" title={hash}>
      {text} ↗
    </a>
  ) : (
    <span className="hash" title={hash}>
      {text}
    </span>
  );
}

export function AddrLink({ address, label }: { address: string; label?: string }) {
  const { explorer } = useApp();
  const href = explorer("address", address);
  const text = label ?? short(address);
  return href ? (
    <a className="hash" href={`${href}#code`} target="_blank" rel="noreferrer" title={address}>
      {text} ↗
    </a>
  ) : (
    <span className="hash" title={address}>
      {text}
    </span>
  );
}

export type BadgeKind = "pass" | "fail" | "review" | "idle" | "skip";
const BADGE_TEXT: Record<BadgeKind, string> = {
  pass: "✓ Passed",
  fail: "✕ Failed",
  review: "! Needs review",
  idle: "· Not run yet",
  skip: "– Not run",
};

export function Badge({ kind, children }: { kind: BadgeKind; children?: ReactNode }) {
  return <span className={`badge ${kind}`}>{children ?? BADGE_TEXT[kind]}</span>;
}

export type Source = "sepolia" | "browser" | "evidence" | "advisory";

export function SourceLabel({ source }: { source: Source }) {
  const { data, offline } = useApp();
  if (source === "sepolia" && offline && data.cached) {
    return <span className="source">⧗ cached · {data.cached.time.slice(0, 10)}</span>;
  }
  const text = {
    sepolia: "◉ live · Sepolia",
    browser: "◎ live · your browser",
    evidence: `▤ exported evidence · ${data.exportDate}`,
    advisory: "≡ rule-based · advisory",
  }[source];
  return (
    <span className="source" title={source === "evidence" ? EVIDENCE_WHY : undefined}>
      {text}
    </span>
  );
}

export const EVIDENCE_WHY =
  "The vLEI credential chain is checked against evidence exported from a local KERI run. KERI agents need a server we do not host here; run the local mode (README › Quick start) to check the chain live.";

export function TabHead({ title, lede, children }: { title: string; lede?: ReactNode; children?: ReactNode }) {
  return (
    <div className="tab-head reveal">
      <h2 className="tab-title">{title}</h2>
      {lede && <p className="tab-lede">{lede}</p>}
      {children}
    </div>
  );
}

export const fmt = (n: number, digits = 1) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
