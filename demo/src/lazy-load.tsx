import { Component, lazy, type ComponentType, type ReactNode } from "react";
import type { Lang } from "./i18n.ts";

/**
 * React.lazy that survives a chunk that fails to load. GitHub Pages answers a chunk with 503 now and then (CI,
 * 17 October 2026: the Supplier tab's shared chunk), and one failed import used to unmount the whole page. It tries
 * once more after 0.5 s (Firefox fetches again); Chromium keeps a failed module for the page's life, so it then
 * reloads the page once (the tab is in the URL). A second failure within a minute is left to LoadBoundary.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the same bound as React.lazy
export function lazyRetry<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      return await load();
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
    try {
      return await load();
    } catch (e) {
      if (reloadOnce()) return new Promise<never>(() => {});
      throw e;
    }
  });
}

const RELOADED_AT = "carbonlei:chunk-reload";

/** Reloads unless the page already did so for a chunk in the last minute; false when it will not. */
function reloadOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOADED_AT) ?? 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(RELOADED_AT, String(Date.now()));
  } catch {
    return false; // Without storage a reload could loop.
  }
  window.location.reload();
  return true;
}

/** Chrome, Firefox and Safari's wording for a dynamic import or a preloaded chunk that failed to fetch. */
const CHUNK_ERROR = /dynamically imported module|Importing a module script failed|Unable to preload|error loading/i;

const S = {
  en: {
    failed: "This part of the page could not load (a network error, not a verification result).",
    crashed: "This part of the page stopped with an error (a page fault, not a verification result).",
    retry: "Reload the page",
  },
  "zh-TW": {
    failed: "這部分頁面載入失敗（是網路錯誤，不是驗證結果）。",
    crashed: "這部分頁面發生錯誤而停止（是頁面故障，不是驗證結果）。",
    retry: "重新載入頁面",
  },
} as const;

/**
 * Catches a chunk that still fails after lazyRetry, so one tab (or one panel) shows a plain message and a reload
 * button instead of the whole page going blank. React.lazy keeps a rejected load, so only a reload tries again; keyed
 * by the tab id, so the other tabs still open.
 */
export class LoadBoundary extends Component<{ lang: Lang; children: ReactNode }, { error: string }> {
  state = { error: "" };

  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  render() {
    if (!this.state.error) return this.props.children;
    const s = S[this.props.lang];
    return (
      <div className="check-detail bad" role="alert">
        <p>{CHUNK_ERROR.test(this.state.error) ? s.failed : s.crashed}</p>
        <p className="fine" lang="en">
          {this.state.error}
        </p>
        <button type="button" className="btn" onClick={() => window.location.reload()}>
          {s.retry}
        </button>
      </div>
    );
  }
}
