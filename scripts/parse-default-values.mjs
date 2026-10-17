// Extracts the CBAM default values of Annex I to Commission Implementing Regulation (EU) 2026/1740 (which replaces
// Annex I to Implementing Regulation (EU) 2025/2621, applicable from 1 January 2026) into
// sdk/data/default-values-2026-1740.json. Deterministic: the same source file gives byte-identical output.
// No dependencies beyond Node.
//
// Source: the English Official Journal XHTML, served by the Publications Office for CELEX 32026R1740 (EUR-Lex's HTML
// view answered 504 on the access date). The file is 16 MB, so only its SHA-256 and the extracted values are kept.
//
// Usage:
//   node scripts/parse-default-values.mjs --fetch            download the source, check its SHA-256, write the JSON
//   node scripts/parse-default-values.mjs <file.xhtml>       parse a local copy instead
//   ... --check                                              compare with the committed JSON instead of writing it
//   ... --accept-new-source                                  accept a source whose SHA-256 differs from the pinned one
//
// What is extracted, per country table (121 countries and "Other Countries and Territories"): every row of the
// annex's tables that carries a CN or TARIC code, with its direct, indirect and total default values
// (tCO2e/tonne of good) and the production-route indicator. Rows whose values read "see below" are group headings
// and are left out. "-" (no value given) is kept as null: the annex's opening paragraph says to use the
// "Other Countries and Territories" table for it, as for a country that is not listed.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_URL = "http://publications.europa.eu/resource/celex/32026R1740";
export const EXPECTED_SHA256 = "4e9291a81606f1a3c0579df63373af52d998817d9de9081f6b579982f88dfb33";
export const ACCESSED = "2026-10-17";
export const OTHER = "OTHER";

/**
 * Country names as the annex's table headings spell them → ISO 3166-1 alpha-2. An unknown heading stops the parse,
 * so a renamed or added country cannot be silently dropped.
 */
export const COUNTRY_CODES = {
  "Albania": "AL", "Algeria": "DZ", "Angola": "AO", "Argentina": "AR", "Armenia": "AM", "Australia": "AU",
  "Azerbaijan": "AZ", "Bahrain": "BH", "Bangladesh": "BD", "Belarus": "BY", "Benin": "BJ", "Bolivia": "BO",
  "Bosnia and Herzegovina": "BA", "Brazil": "BR", "Brunei": "BN", "Cambodia": "KH", "Cameroon": "CM", "Canada": "CA",
  "Chile": "CL", "China": "CN", "Colombia": "CO", "Congo": "CG", "Congo, Democratic Republic of": "CD",
  "Costa Rica": "CR", "Cuba": "CU", "Curaçao": "CW", "Dominican Republic": "DO", "Ecuador": "EC", "Egypt": "EG",
  "El Salvador": "SV", "Equatorial Guinea": "GQ", "Eritrea": "ER", "Eswatini": "SZ", "Ethiopia": "ET", "Gabon": "GA",
  "Georgia": "GE", "Ghana": "GH", "Guatemala": "GT", "Haiti": "HT", "Honduras": "HN", "Hong Kong": "HK", "India": "IN",
  "Indonesia": "ID", "Iran, Islamic Republic of": "IR", "Iraq": "IQ", "Israel": "IL", "Ivory Coast": "CI",
  "Jamaica": "JM", "Japan": "JP", "Jordan": "JO", "Kazakhstan": "KZ", "Kenya": "KE",
  "Korea, Republic of (South Korea)": "KR", "Kuwait": "KW", "Kyrgyzstan": "KG", "Laos": "LA", "Lebanon": "LB",
  "Liberia": "LR", "Libya": "LY", "Madagascar": "MG", "Malaysia": "MY", "Mali": "ML", "Mauritania": "MR",
  "Mauritius": "MU", "Mexico": "MX", "Moldova, Republic of": "MD", "Mongolia": "MN", "Montenegro": "ME",
  "Morocco": "MA", "Mozambique": "MZ", "Myanmar": "MM", "Namibia": "NA", "Nepal": "NP",
  "New Caledonia and dependencies": "NC", "New Zealand": "NZ", "Nicaragua": "NI", "Niger": "NE", "Nigeria": "NG",
  "North Korea (Democratic People’s Republic of Korea)": "KP", "North Macedonia": "MK", "Oman": "OM",
  "Pakistan": "PK", "Panama": "PA", "Papua New Guinea": "PG", "Paraguay": "PY", "Peru": "PE", "Philippines": "PH",
  "Qatar": "QA", "Russian Federation": "RU", "Rwanda": "RW", "Saudi Arabia": "SA", "Senegal": "SN", "Serbia": "RS",
  "Sierra Leone": "SL", "Singapore": "SG", "South Africa": "ZA", "Sri Lanka": "LK", "Sudan": "SD", "Suriname": "SR",
  "Syria": "SY", "Taiwan": "TW", "Tajikistan": "TJ", "Tanzania, United Republic of": "TZ", "Thailand": "TH",
  "Togo": "TG", "Trinidad and Tobago": "TT", "Tunisia": "TN", "Türkiye": "TR", "Turkmenistan": "TM", "Uganda": "UG",
  "Ukraine": "UA", "United Arab Emirates": "AE", "United Kingdom": "GB", "United States": "US", "Uruguay": "UY",
  "Uzbekistan": "UZ", "Venezuela": "VE", "Viet Nam": "VN", "Yemen": "YE", "Zambia": "ZM", "Zimbabwe": "ZW",
  "Other Countries and Territories": OTHER,
};

const HEADER = [
  "Product CN Code / TARIC Code",
  "Description",
  "Default Value (direct emissions) (tCO2eq/tonne of good)",
  "Default Value (indirect emissions) (tCO2eq/tonne of good)",
  "Default Value (total emissions) (tCO2eq/tonne of good)",
  "Underlying production route determining CBAM BM",
];
const SECTIONS = new Set(["Cement", "Fertilisers", "Aluminium", "Hydrogen", "Iron and steel"]);

const text = (h) =>
  h
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** "2,707" → "2.707"; "-" → null; "N/A" stays "N/A" (indirect column only). */
function value(cell, where, allowNA) {
  if (cell === "-") return null;
  if (allowNA && cell === "N/A") return "N/A";
  const m = /^(\d+),(\d{3})$/.exec(cell);
  if (!m) throw new Error(`${where}: unexpected value "${cell}"`);
  return `${m[1]}.${m[2]}`;
}

/**
 * Parses Annex I of the regulation's XHTML. Returns { countries: { ISO: { name, rows: { code: [direct, indirect,
 * total, route] } } }, stats }. Throws on any table, header, code or value it does not recognise.
 */
export function parseAnnexI(xhtml) {
  const start = xhtml.indexOf("Default values for goods imported into the customs territory of the Union, except for electricity");
  const end = xhtml.indexOf(">ANNEX II<", start);
  if (start < 0 || end < 0) throw new Error("Annex I not found (opening title or ANNEX II heading missing)");
  const annex = xhtml.slice(start, end);
  const countries = {};
  const stats = { tables: 0, rows: 0, valued: 0, noValue: 0, groupHeadings: 0, totalNotDirectPlusIndirect: [], maxDifference: "0.000" };
  for (const t of annex.matchAll(/<table[^>]*class="oj-table"[^>]*>([\s\S]*?)<\/table>/g)) {
    const rows = [...t[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) =>
      [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => text(c[1])),
    );
    if (rows[0]?.length !== 1) throw new Error(`table ${stats.tables + 1}: first row is not a country heading`);
    const name = rows[0][0];
    const iso = COUNTRY_CODES[name];
    if (!iso) throw new Error(`unknown country heading "${name}"`);
    if (countries[iso]) throw new Error(`country "${name}" appears twice`);
    // Oman's sixth heading reads "A Underlying production route …" in the source; only that stray prefix is tolerated.
    const heads = rows[1]?.map((h, k) => (k === 5 ? h.replace(/^A (?=Underlying)/, "") : h));
    if (JSON.stringify(heads) !== JSON.stringify(HEADER)) throw new Error(`${name}: unexpected column headings ${JSON.stringify(rows[1])}`);
    stats.tables++;
    const out = {};
    for (const r of rows.slice(2)) {
      if (r.length !== 6) throw new Error(`${name}: row with ${r.length} cells: ${JSON.stringify(r)}`);
      const [codeCell, , d, i, tot, route] = r;
      if (SECTIONS.has(codeCell) && !d && !i && !tot && !route) continue; // sector heading
      if (!/^\d{4}( \d{2}){0,2}$|^\d{10}$/.test(codeCell)) throw new Error(`${name}: unexpected code "${codeCell}"`);
      const code = codeCell.replace(/ /g, "");
      const where = `${name} ${codeCell}`;
      if (d === "see below" && i === "see below" && tot === "see below") {
        stats.groupHeadings++;
        continue;
      }
      if (code in out) throw new Error(`${where}: code listed twice`);
      if (route && !/^\([A-L]\)(\/\([A-L]\))?$/.test(route)) throw new Error(`${where}: unexpected route "${route}"`);
      const row = [value(d, where, false), value(i, where, true), value(tot, where, false), route.replace(/[()]/g, "")];
      if ((row[0] === null) !== (row[2] === null)) throw new Error(`${where}: direct and total disagree on "-"`);
      stats.rows++;
      if (row[2] === null) stats.noValue++;
      else {
        stats.valued++;
        const milli = (v) => (v === null || v === "N/A" ? 0 : Number(v.replace(".", "")));
        const diff = Math.abs(milli(row[2]) - milli(row[0]) - milli(row[1]));
        if (diff) stats.totalNotDirectPlusIndirect.push(`${iso}:${code}`);
        if (diff > Number(stats.maxDifference.replace(".", ""))) stats.maxDifference = (diff / 1000).toFixed(3);
      }
      out[code] = row;
    }
    countries[iso] = { name, rows: out };
  }
  if (!countries[OTHER]) throw new Error('no "Other Countries and Territories" table');
  return { countries, stats };
}

/** The JSON document written to sdk/data (keys sorted, so the output is byte-stable). */
export function buildDocument(xhtml, sha256) {
  const { countries, stats } = parseAnnexI(xhtml);
  const sorted = {};
  for (const iso of Object.keys(countries).sort()) {
    const rows = {};
    for (const code of Object.keys(countries[iso].rows).sort()) rows[code] = countries[iso].rows[code];
    sorted[iso] = { name: countries[iso].name, rows };
  }
  return {
    format: 1,
    source: {
      act: "Commission Implementing Regulation (EU) 2026/1740 of 20 July 2026 correcting Implementing Regulation (EU) 2025/2621 as regards Annexes I and IV thereto, OJ L, 2026/1740, 31.7.2026",
      part: "Annex I (replaces Annex I to Implementing Regulation (EU) 2025/2621; applies from 1 January 2026, Article 2)",
      url: SOURCE_URL,
      eli: "http://data.europa.eu/eli/reg_impl/2026/1740/oj",
      format: "Official Journal XHTML, English (served by the Publications Office for CELEX 32026R1740)",
      sha256,
      accessed: ACCESSED,
      parser: "scripts/parse-default-values.mjs",
    },
    columns: ["direct", "indirect", "total", "route"],
    semantics: [
      "Values are tCO2e per tonne of good, without mark-up, as decimal strings with the annex's 3 decimals.",
      "Annex I opening: 'For the calculation of the number of CBAM certificates, the default values of the column \"total emissions\" shall be selected and increased' by the mark-up (10/20/30 % for 2026/2027/2028+, 1 % for fertilisers). Recital 10: the direct and indirect values 'have only been provided for information'. CarbonLEI uses `total`.",
      "Annex I opening: 'Where a country or territory is not explicitly listed', or it is listed 'but no value is provided or the relevant field shows \"–\"', the value of the table 'Other Countries and Territories' (key OTHER) is selected.",
      "null in `direct` and `total` is the annex's '-' (no value); 'N/A' in `indirect` is the annex's 'N/A'. `route` is the production-route indicator (A–L), '' when none is given.",
      "In some rows the printed total differs from direct + indirect by a rounding step (listed in stats); the total is used as printed.",
      "Codes are the annex's CN codes without spaces (4, 6 or 8 digits) or 10-digit TARIC codes. Group headings whose values read 'see below' are not stored.",
    ],
    stats: {
      countryTables: stats.tables,
      rows: stats.rows,
      rowsWithValue: stats.valued,
      rowsWithoutValue: stats.noValue,
      groupHeadingsSkipped: stats.groupHeadings,
      totalNotEqualDirectPlusIndirect: stats.totalNotDirectPlusIndirect,
      maxDifferenceTotalVsDirectPlusIndirect: stats.maxDifference,
    },
    countries: sorted,
  };
}

/** One row per line, so a diff of the data shows which values changed. */
export function serialise(doc) {
  const { countries, ...head } = doc;
  const lines = [];
  const isos = Object.keys(countries);
  isos.forEach((iso, ci) => {
    const codes = Object.keys(countries[iso].rows);
    lines.push(`    ${JSON.stringify(iso)}: { "name": ${JSON.stringify(countries[iso].name)}, "rows": {`);
    codes.forEach((code, i) => lines.push(`      ${JSON.stringify(code)}: ${JSON.stringify(countries[iso].rows[code])}${i < codes.length - 1 ? "," : ""}`));
    lines.push(`    } }${ci < isos.length - 1 ? "," : ""}`);
  });
  const headJson = JSON.stringify(head, null, 2);
  return `${headJson.slice(0, -2)},\n  "countries": {\n${lines.join("\n")}\n  }\n}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const outPath = resolve(root, "sdk/data/default-values-2026-1740.json");
  let buf;
  if (args.includes("--fetch")) {
    const res = await fetch(SOURCE_URL, { headers: { Accept: "application/xhtml+xml", "Accept-Language": "en" }, signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new Error(`${SOURCE_URL}: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } else {
    const file = args.find((a) => !a.startsWith("--"));
    if (!file) throw new Error("pass --fetch or the path of a downloaded copy of the source");
    buf = readFileSync(file);
  }
  const sha256 = createHash("sha256").update(buf).digest("hex");
  if (sha256 !== EXPECTED_SHA256 && !args.includes("--accept-new-source")) {
    throw new Error(`source SHA-256 ${sha256} differs from the pinned ${EXPECTED_SHA256}; check the act, then rerun with --accept-new-source and update EXPECTED_SHA256 and ACCESSED`);
  }
  const doc = buildDocument(buf.toString("utf8"), sha256);
  const out = serialise(doc);
  JSON.parse(out); // well-formed
  if (args.includes("--check")) {
    const same = readFileSync(outPath, "utf8") === out;
    console.log(same ? `${outPath} matches the source` : `${outPath} DIFFERS from the source`);
    process.exit(same ? 0 : 1);
  }
  writeFileSync(outPath, out);
  const s = doc.stats;
  console.log(`wrote ${outPath}: ${s.countryTables} tables, ${s.rows} rows (${s.rowsWithValue} with a value, ${s.rowsWithoutValue} "-"), sha256 ${sha256}`);
  if (s.totalNotEqualDirectPlusIndirect.length) console.log(`total ≠ direct + indirect in ${s.totalNotEqualDirectPlusIndirect.length} rows`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
