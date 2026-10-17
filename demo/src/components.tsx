import type { ReactNode } from "react";
import { useApp } from "./App.tsx";
import { EVIDENCE_WHY, EVIDENCE_WHY_ZH, short } from "./data.ts";
import { useLang } from "./i18n.ts";

export { EVIDENCE_WHY, fmt } from "./data.ts";

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
const BADGE_TEXT_ZH: Record<BadgeKind, string> = { pass: "✓ 通過", fail: "✕ 未通過", review: "! 需審查", idle: "· 尚未執行", skip: "– 未執行" };

/** A result badge; without children it shows the default text in the page's language. */
export function Badge({ kind, children }: { kind: BadgeKind; children?: ReactNode }) {
  const zh = useLang().lang === "zh-TW";
  return <span className={`badge ${kind}`}>{children ?? (zh ? BADGE_TEXT_ZH : BADGE_TEXT)[kind]}</span>;
}

export type Source = "sepolia" | "browser" | "evidence" | "advisory";

export function SourceLabel({ source }: { source: Source }) {
  const { data, offline } = useApp();
  const zh = useLang().lang === "zh-TW";
  if (source === "sepolia" && offline && data.cached) {
    return <span className="source">{zh ? "⧗ 快取" : "⧗ cached"} · {data.cached.time.slice(0, 10)}</span>;
  }
  const text = (
    zh
      ? { sepolia: "◉ 即時 · Sepolia", browser: "◎ 即時 · 您的瀏覽器", evidence: `▤ 匯出的證據 · ${data.exportDate}`, advisory: "≡ 規則式 · 僅供參考" }
      : { sepolia: "◉ live · Sepolia", browser: "◎ live · your browser", evidence: `▤ exported evidence · ${data.exportDate}`, advisory: "≡ rule-based · advisory" }
  )[source];
  return (
    <span className="source" title={source === "evidence" ? (zh ? EVIDENCE_WHY_ZH : EVIDENCE_WHY) : undefined}>
      {text}
    </span>
  );
}

export function TabHead({ title, lede, children }: { title: string; lede?: ReactNode; children?: ReactNode }) {
  return (
    <div className="tab-head reveal">
      <h2 className="tab-title">{title}</h2>
      {lede && <p className="tab-lede">{lede}</p>}
      {children}
    </div>
  );
}
