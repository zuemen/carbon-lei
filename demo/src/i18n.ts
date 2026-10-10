// Language switch: English (default) or Traditional Chinese (Taiwan) for the parts a Taiwanese supplier needs first —
// the first screen's CBAM explanation, the tab bar, the Supplier tab, and the Buyer tab's verdict and check names.
// No library: each component holds its own `{ en, "zh-TW" }` strings and picks one with `useLang()`. Technical
// identifiers (error codes, check numbers, hashes, vLEI, KERI, CBAM, EORI, tCO2e) are never translated.
import { createContext, createElement, type ReactNode, useCallback, useContext, useEffect, useState } from "react";

export type Lang = "en" | "zh-TW";
export const LANGS: readonly Lang[] = ["en", "zh-TW"];
/** BCP 47 tag for `<html lang>` (and the `lang` of the switch buttons). */
export const HTML_LANG: Record<Lang, string> = { en: "en", "zh-TW": "zh-Hant-TW" };
const STORAGE_KEY = "carbonlei.lang";

function parse(v: string | null | undefined): Lang | null {
  if (!v) return null;
  if (/^zh/i.test(v)) return "zh-TW";
  if (/^en/i.test(v)) return "en";
  return null;
}

/** `?lang=` in the query string (or in the hash's query, as in `#buyer?lang=zh-TW`), else the saved choice, else English. */
export function initialLang(): Lang {
  try {
    const fromSearch = new URLSearchParams(window.location.search).get("lang");
    const hashQuery = window.location.hash.split("?")[1];
    const fromHash = hashQuery ? new URLSearchParams(hashQuery).get("lang") : null;
    const fromUrl = parse(fromSearch) ?? parse(fromHash);
    if (fromUrl) return fromUrl;
  } catch {
    // ignore a malformed URL
  }
  try {
    return parse(window.localStorage.getItem(STORAGE_KEY)) ?? "en";
  } catch {
    return "en";
  }
}

interface LangCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
}

const LangContext = createContext<LangCtx>({ lang: "en", setLang: () => undefined });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangRaw] = useState<Lang>(initialLang);
  useEffect(() => {
    document.documentElement.lang = HTML_LANG[lang];
  }, [lang]);
  const setLang = useCallback((l: Lang) => {
    setLangRaw(l);
    try {
      window.localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // storage blocked (private window, previews): the choice lasts for this page only
    }
  }, []);
  return createElement(LangContext.Provider, { value: { lang, setLang } }, children);
}

export const useLang = () => useContext(LangContext);

/** Picks the strings of the current language from a `{ en, "zh-TW" }` table. */
export function useStrings<T>(table: Record<Lang, T>): T {
  return table[useLang().lang];
}
