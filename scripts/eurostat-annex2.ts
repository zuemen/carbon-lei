// Totals the 2025 EU import tonnage of the goods whose CBAM embedded emissions are direct emissions only
// (Annex II of Regulation (EU) 2023/956, iron and steel, aluminium and hydrogen), using the same CN list the
// Communication Template importer uses (sdk/template.ts). Electricity (2716 00 00) is left out: it is in
// Annex II but counted per MWh, not per tonne. Read only; queries Eurostat Comext DS-045409 (annual, imports).
//
// The tonnage is gross trade: it includes imports below the CBAM 50 t threshold and imports under customs
// procedures that CBAM treats differently, so it is an upper bound on what CBAM declarations cover.
//
// Usage: node scripts/eurostat-annex2.ts [--year 2025] [--partner EXT_EU --partner TW]
import { parseArgs } from "node:util";
import { ANNEX_II_EXCEPT, DIRECT_ONLY_CN_PREFIXES } from "../sdk/template.ts";

const API = "https://ec.europa.eu/eurostat/api/comext/dissemination/statistics/1.0/data/DS-045409";
/** Comext has no 5-digit level; 7202 2 (ferro-silicon) has the two HS subheadings 7202 21 and 7202 29. */
const FIVE_DIGIT: Record<string, string[]> = { "72022": ["720221", "720229"] };

const counted = DIRECT_ONLY_CN_PREFIXES.filter((cn) => cn !== "27160000");
const excluded = ANNEX_II_EXCEPT.flatMap((cn) => FIVE_DIGIT[cn] ?? [cn]);

interface Dataset {
  id: string[];
  size: number[];
  dimension: Record<string, { category: { index: Record<string, number> } }>;
  value: Record<string, number>;
  updated?: string;
}

async function tonnes(partner: string, year: string): Promise<{ total: number; byCode: Record<string, number>; updated?: string }> {
  const codes = [...counted, ...excluded];
  const url = `${API}?format=JSON&freq=A&reporter=EU&flow=1&time=${year}&partner=${partner}` + codes.map((c) => `&product=${c}`).join("");
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Eurostat ${res.status} for ${partner}`);
  const d = (await res.json()) as Dataset;
  const stride = d.size.map((_, i) => d.size.slice(i + 1).reduce((a, b) => a * b, 1));
  const at = (dim: string, key: string) => d.dimension[dim].category.index[key] * stride[d.id.indexOf(dim)];
  const byCode: Record<string, number> = {};
  for (const c of codes) {
    if (d.dimension.product.category.index[c] === undefined) throw new Error(`Eurostat returned no row for ${c}`);
    byCode[c] = (d.value[String(at("product", c) + at("indicators", "QUANTITY_IN_100KG"))] ?? 0) / 10;
  }
  const total = counted.reduce((s, c) => s + byCode[c], 0) - excluded.reduce((s, c) => s + byCode[c], 0);
  return { total, byCode, updated: d.updated };
}

const { values } = parseArgs({ options: { year: { type: "string", default: "2025" }, partner: { type: "string", multiple: true } } });
const partners = values.partner ?? ["EXT_EU", "TW"];
for (const p of partners) {
  const r = await tonnes(p, values.year!);
  console.log(`${p} ${values.year}: ${Math.round(r.total).toLocaleString("en")} t (chapter 72 ${Math.round(r.byCode["72"]).toLocaleString("en")} t, minus Annex II exceptions ${Math.round(excluded.reduce((s, c) => s + r.byCode[c], 0)).toLocaleString("en")} t; CN 7318 ${Math.round(r.byCode["7318"]).toLocaleString("en")} t; dataset updated ${r.updated ?? "n/a"})`);
}
