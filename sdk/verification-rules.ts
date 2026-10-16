// Check 8 sub-rules on the verification report itself: when it was issued, the site visit, and the
// verifier's accreditation at the report date (rule set `carbonlei-verification-rules/1`).
//
// They run on the same report extract as the reconciliation rules of sdk/consistency.ts, but are NOT part of
// the signed reconciliation (its rule-version hash is in every issued credential, so adding rules there would
// break every credential already signed). They run at verification time instead:
// - When the extract is the one the auditor reconciled and signed (check 8's three hashes match), a rule
//   breached by that signed data is a hard regulatory violation: the sub-rule fails and so does check 8 (INVALID).
// - When the extract is not covered by a signature, the same breach is only a warning (advisory).
// - Anything that needs a person's judgement (a force-majeure virtual visit, a waiver, operator metadata that
//   does not match) is a warning; a check 8 warning never changes the verdict.
//
// Sources (accessed 2026-10-16):
// - Commission, CBAM verification page, timeline: "January 2027 — Accredited CBAM verifiers can issue first
//   verification reports". https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-verification_en
// - Commission, Guidance on CBAM verification and accreditation for verifiers and NABs (24 August 2026),
//   §4.1: the reporting period is the calendar year and "verification cannot be concluded before January of the
//   subsequent year"; §7.3: a verifier must have been "duly accredited (… neither suspended nor withdrawn) at the
//   time of issuing the verification statement, and the accreditation covered all relevant sectoral scopes";
//   §4.9: site visits; §9.2: accreditation to EN ISO/IEC 17029 with EN ISO 14065, activity groups of Annex I
//   to Delegated Regulation (EU) 2025/2551, certificate valid at most five years (Art 51 AVR-DA);
//   §10.2: registration data of Art 10a(2) of the CBAM Registry Act; the Commission "will also publish on a
//   regular basis information on accredited CBAM verifiers".
//   https://taxation-customs.ec.europa.eu/document/download/030fe146-38e5-46b8-82b5-5f72da089a7b_en
// - Implementing Regulation (EU) 2025/2546, Art 2 (a physical site visit may be replaced by a virtual one only
//   under Art 3 or 4, or waived only under Art 3), Art 3(1)(a)-(b) (a virtual visit needs a physical visit in the
//   immediately preceding reporting period; a waiver, physical visits in the two preceding periods), Art 4
//   (virtual visit for serious, extraordinary and unforeseeable circumstances), Annex 1.3 (verifier identification:
//   accreditation number, NAB name and country, expiry, scope), 2.2 (site visit details, incl. the date of the
//   last physical site visit), 2.6(h) (date and signature by an authorised person). Text via
//   https://lawplayer.com/eu/article/32025R2546/art_2 (…/art_3, art_4, anx_1), compiled from EUR-Lex.
import { hashString } from "./commitment.ts";
import { cnInScope, type ReportExtract } from "./consistency.ts";

export const VERIFICATION_RULES_VERSION = "carbonlei-verification-rules/1";

/** First day on which accredited verifiers can issue CBAM verification reports (Commission timeline). */
export const FIRST_REPORT_DATE = "2027-01-01";

/** Date the Commission's list of accredited CBAM verifiers was last checked and found unpublished. */
export const COMMISSION_LIST_CHECKED = "2026-10-16";

/** EU Member States (ISO 3166-1 alpha-2): a CBAM accreditation is granted by the NAB of a Member State. */
export const EU_MEMBER_STATES = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "GR", "DE", "HU", "IE", "IT", "LV", "LT", "LU",
  "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
] as const;

/**
 * CBAM accreditation activity group for a CN code, where the mapping is unambiguous (Table 11 of the guidance,
 * Annex I to Delegated Regulation (EU) 2025/2551). Other codes are not mapped and the sub-rule only notes that.
 */
export function activityGroupOf(cnCode: string): string | undefined {
  if (cnCode.startsWith("73")) return "VIII"; // iron or steel products (chapter 73)
  if (cnCode.startsWith("2523")) return "I"; // cement
  if (cnCode.startsWith("2716")) return "LI"; // electricity imported into the customs territory of the Union
  return undefined;
}

export type SubRuleStatus = "pass" | "fail" | "warn" | "note";

/** One sub-rule of check 8, shown under the check. `note` is information only: it never changes the check. */
export interface SubRule {
  rule: string;
  status: SubRuleStatus;
  code: string;
  detail: string;
}

/**
 * What the allowlist operator records off-chain for a verification body (OPERATE.md): the registration data of
 * Art 10a(2) of the CBAM Registry Act plus the accreditation standard, linked to the on-chain allowlist entry by
 * the body's LEI and the accreditation credential's SAID hash. It is operator data, not signed by the NAB.
 */
export interface AccreditationRecord {
  verifierLEI: string;
  verifierName: string;
  countryOfEstablishment: string;
  accreditationNumber: string;
  nab: { name: string; country: string; lei?: string; registerUrl?: string };
  standards: string[];
  activityGroups: string[];
  cnScope: string[];
  validFrom: string;
  validUntil: string;
  /** Suspensions, withdrawals or scope reductions, with the period they apply to (`until` absent: still in force). */
  administrativeMeasures: { type: string; from: string; until?: string }[];
  /** hashString of the accreditation credential's SAID, as in the on-chain allowlist entry. */
  accreditationSaidHash?: string;
  certificateSha256?: string;
}

export interface AccreditationRegistry {
  schema: string;
  operator: string;
  /** Whether the Commission had published its list of accredited CBAM verifiers when the operator last checked. */
  commissionList: { published: boolean; checkedAt: string; source: string };
  records: AccreditationRecord[];
}

const DAY = /^\d{4}-\d{2}-\d{2}/;
const day = (s: unknown): string | undefined => (typeof s === "string" && DAY.test(s) ? s.slice(0, 10) : undefined);

/** Shape problems of a registry file (it is loaded from disk or the network), or null. */
export function registryShapeProblem(x: unknown): string | null {
  const r = x as AccreditationRegistry;
  if (typeof r !== "object" || r === null || !Array.isArray(r.records)) return "the accreditation registry has no records list";
  if (typeof r.commissionList?.published !== "boolean") return "the accreditation registry does not say whether the Commission list is published";
  for (const e of r.records) {
    if (typeof e?.verifierLEI !== "string" || typeof e.accreditationNumber !== "string") return "a registry record has no LEI or accreditation number";
    if (!Array.isArray(e.cnScope) || !Array.isArray(e.activityGroups) || !Array.isArray(e.standards) || !Array.isArray(e.administrativeMeasures)) {
      return "a registry record has a list field of the wrong type";
    }
  }
  return null;
}

/** Rules on the report's dates and site visit (the extract has passed extractShapeProblem). */
export function reportRules(x: ReportExtract, signed: boolean): SubRule[] {
  const hard = (ok: boolean, rule: string, code: string, okDetail: string, badDetail: string): SubRule =>
    ok
      ? { rule, status: "pass", code: "", detail: okDetail }
      : { rule, status: signed ? "fail" : "warn", code, detail: signed ? badDetail : `${badDetail} (the extract is not covered by a signature: advisory)` };
  const out: SubRule[] = [];
  const signedAt = day(x.signedAt);
  const end = day(String(x.reportingPeriod ?? "").split("/")[1]);

  // 1. Not before verifiers could issue reports (Commission timeline: January 2027).
  if (signedAt) {
    out.push(
      hard(
        signedAt >= FIRST_REPORT_DATE,
        "first-report-date",
        "VERIFICATION_RULE/REPORT_BEFORE_FIRST_ISSUE_DATE",
        `dated on or after ${FIRST_REPORT_DATE}, when accredited verifiers could first issue CBAM verification reports`,
        `report dated ${signedAt}, before ${FIRST_REPORT_DATE}: no accredited verifier could issue a CBAM verification report yet`,
      ),
    );
  }
  // 2. Issued after the reporting period ended (guidance §4.1).
  if (!signedAt || !end) {
    out.push({ rule: "report-after-period", status: "warn", code: "VERIFICATION_RULE/DATE_UNREADABLE", detail: "the report date or the end of the reporting period is not a date" });
  } else {
    out.push(
      hard(
        signedAt > end,
        "report-after-period",
        "VERIFICATION_RULE/REPORT_BEFORE_PERIOD_END",
        `report dated ${signedAt}, after the reporting period ended on ${end}`,
        `report dated ${signedAt}, but the reporting period ends on ${end}: verification cannot be concluded before the period is over`,
      ),
    );
  }
  // 3. Accreditation valid on the report date (guidance §7.3), from the report's own expiry (Annex 1.3(g)).
  const until = day(x.accreditedUntil);
  if (!signedAt || !until) {
    out.push({ rule: "accreditation-at-report-date", status: "warn", code: "VERIFICATION_RULE/ACCREDITATION_DATE_MISSING", detail: "the report does not give a readable accreditation expiry date" });
  } else {
    out.push(
      hard(
        signedAt <= until,
        "accreditation-at-report-date",
        "VERIFICATION_RULE/ACCREDITATION_EXPIRED_AT_REPORT",
        `accreditation valid until ${until}, covering the report date ${signedAt}`,
        `accreditation expired on ${until}, before the report date ${signedAt}`,
      ),
    );
  }
  out.push(siteVisitRule(x, signed, hard));
  return out;
}

/** Site visit (IR 2025/2546 Art 2-4; Annex 2.2). */
function siteVisitRule(
  x: ReportExtract,
  signed: boolean,
  hard: (ok: boolean, rule: string, code: string, okDetail: string, badDetail: string) => SubRule,
): SubRule {
  const rule = "site-visit";
  const visit = typeof x.siteVisit === "string" ? x.siteVisit.trim().toLowerCase() : "";
  const reason = (x as ReportExtract & { siteVisitReason?: unknown }).siteVisitReason;
  const forceMajeure = reason === "force-majeure";
  const first = x.firstVerifiedPeriod === true;
  const review = (code: string, detail: string): SubRule => ({ rule, status: "warn", code, detail });
  if (!visit) return review("VERIFICATION_RULE/SITE_VISIT_NOT_STATED", "the report extract does not state the site visit (Annex 2.2): needs a person to read the report");
  if (visit === "physical") return { rule, status: "pass", code: "", detail: "physical site visit stated" };
  if (visit === "virtual" && forceMajeure) {
    return review(
      "VERIFICATION_RULE/SITE_VISIT_FORCE_MAJEURE",
      "virtual site visit for serious, extraordinary and unforeseeable circumstances (Art 4): a person should read the reasons the report gives",
    );
  }
  if (first) {
    // No physical visit in a preceding period exists, so Art 3 cannot apply; only Art 4 allows a virtual visit.
    return hard(
      false,
      rule,
      "VERIFICATION_RULE/FIRST_PERIOD_NO_PHYSICAL_VISIT",
      "",
      visit === "virtual"
        ? "first verified period with a virtual site visit and no force-majeure reason (Art 4): Art 3 needs a physical visit in the preceding period"
        : `first verified period without a physical site visit ("${visit}"): a waiver needs physical visits in the two preceding periods (Art 3)`,
    );
  }
  const last = day((x as ReportExtract & { lastPhysicalSiteVisit?: unknown }).lastPhysicalSiteVisit);
  const startYear = Number(String(x.reportingPeriod ?? "").slice(0, 4));
  if (visit === "virtual") {
    // The preceding period's visit can take place during that period or during its verification early in the
    // next year (guidance §4.1), so a last physical visit in either calendar year is accepted.
    const lastYear = last ? Number(last.slice(0, 4)) : NaN;
    if (lastYear === startYear - 1 || lastYear === startYear) {
      return {
        rule,
        status: "pass",
        code: "",
        detail: `virtual site visit; last physical visit ${last}, for the preceding reporting period (Art 3(1)(a); the other conditions of Art 3 are the verifier's judgement)`,
      };
    }
    return review(
      "VERIFICATION_RULE/SITE_VISIT_VIRTUAL_UNSUPPORTED",
      last
        ? `virtual site visit, but the last physical visit (${last}) was not in the preceding reporting period (Art 3(1)(a))`
        : "virtual site visit, and the extract does not give the date of the last physical visit (Annex 2.2(b))",
    );
  }
  if (visit === "waived" || visit === "none") {
    return review("VERIFICATION_RULE/SITE_VISIT_WAIVED", "site visit waived: needs physical visits in the two preceding periods (Art 3(1)(b)); a person should check the report");
  }
  return review("VERIFICATION_RULE/SITE_VISIT_NOT_STATED", `site visit "${visit}" is not physical, virtual or waived`);
}

/**
 * Accreditation provenance: the allowlist operator's record for the body, checked against the report and the
 * credential. All findings are warnings at most (the record is operator data, not signed by the NAB). The
 * Commission list is a `note` while unpublished.
 */
export function provenanceRules(
  reg: AccreditationRegistry,
  x: ReportExtract,
  ctx: { verifierLEI: string; cnCode: string; accreditationSaidHash?: string },
): SubRule[] {
  const out: SubRule[] = [];
  const warn = (rule: string, code: string, detail: string): SubRule => ({ rule, status: "warn", code, detail });
  const pass = (rule: string, detail: string): SubRule => ({ rule, status: "pass", code: "", detail });
  const rec = reg.records.find((r) => r.verifierLEI === ctx.verifierLEI);
  if (!rec) {
    out.push(warn("allowlist-record", "VERIFIER_PROVENANCE/NO_RECORD", `the allowlist operator has no accreditation record for LEI ${ctx.verifierLEI}`));
  } else {
    out.push(pass("allowlist-record", `operator record: ${rec.verifierName} (${rec.countryOfEstablishment}), accredited by ${rec.nab.name} (${rec.nab.country})`));
    const same = rec.accreditationNumber === x.accreditationNumber && rec.nab.name === x.nabName;
    out.push(
      same
        ? pass("record-matches-report", `accreditation ${rec.accreditationNumber} by ${rec.nab.name}, as in the report`)
        : warn("record-matches-report", "VERIFIER_PROVENANCE/RECORD_MISMATCH", `the report names accreditation ${x.accreditationNumber} by ${x.nabName}; the operator record says ${rec.accreditationNumber} by ${rec.nab.name}`),
    );
    if (ctx.accreditationSaidHash !== undefined && rec.accreditationSaidHash !== undefined && rec.accreditationSaidHash !== ctx.accreditationSaidHash) {
      out.push(warn("record-credential", "VERIFIER_PROVENANCE/RECORD_MISMATCH", "the operator record names another accreditation credential than the allowlist entry"));
    }
    out.push(
      (EU_MEMBER_STATES as readonly string[]).includes(rec.nab.country)
        ? pass("nab-member-state", `the accreditation body is established in ${rec.nab.country}, an EU Member State`)
        : warn("nab-member-state", "VERIFIER_PROVENANCE/NAB_NOT_EU", `the accreditation body's country "${rec.nab.country}" is not an EU Member State`),
    );
    out.push(
      rec.standards.some((s) => /17029/.test(s))
        ? pass("standard", `accredited to ${rec.standards.join(" with ")}`)
        : warn("standard", "VERIFIER_PROVENANCE/STANDARD", "the record does not name EN ISO/IEC 17029, the standard CBAM accreditation uses"),
    );
    const group = activityGroupOf(ctx.cnCode);
    const cnOk = cnInScope(ctx.cnCode, rec.cnScope);
    const groupOk = group === undefined || rec.activityGroups.includes(group);
    out.push(
      cnOk && groupOk
        ? pass("scope", `CN ${ctx.cnCode} in scope${group ? ` (activity group ${group})` : "; this CN code is not mapped to an activity group here"}`)
        : warn(
            "scope",
            "VERIFIER_PROVENANCE/OUT_OF_SCOPE",
            !cnOk ? `CN ${ctx.cnCode} is not in the record's scope (${rec.cnScope.join(", ")})` : `CN ${ctx.cnCode} needs activity group ${group}; the record lists ${rec.activityGroups.join(", ")}`,
          ),
    );
    const at = day(x.signedAt);
    const from = day(rec.validFrom);
    const until = day(rec.validUntil);
    const measure = at ? rec.administrativeMeasures.find((m) => (day(m.from) ?? "") <= at && (m.until === undefined || at < (day(m.until) ?? ""))) : undefined;
    // An accreditation certificate may be valid for at most five years (Art 51 AVR-DA).
    const fiveYears = from && until ? until <= `${Number(from.slice(0, 4)) + 5}${from.slice(4)}` : false;
    if (!at || !from || !until) {
      out.push(warn("valid-at-report", "VERIFIER_PROVENANCE/DATES", "the record or the report has no readable validity or report date"));
    } else if (at < from || at > until) {
      out.push(warn("valid-at-report", "VERIFIER_PROVENANCE/NOT_VALID_AT_REPORT", `report dated ${at}, outside the recorded accreditation ${from} to ${until}`));
    } else if (measure) {
      out.push(warn("valid-at-report", "VERIFIER_PROVENANCE/MEASURE_IN_FORCE", `${measure.type} in force on the report date ${at} (from ${measure.from})`));
    } else if (!fiveYears) {
      out.push(warn("valid-at-report", "VERIFIER_PROVENANCE/DATES", `recorded validity ${from} to ${until} is longer than the five years an accreditation certificate may run`));
    } else if (day(x.accreditedUntil) !== until) {
      out.push(warn("valid-at-report", "VERIFIER_PROVENANCE/RECORD_MISMATCH", `the report gives expiry ${x.accreditedUntil}; the record ${until}`));
    } else {
      out.push(pass("valid-at-report", `accredited ${from} to ${until}, no suspension or withdrawal on the report date ${at}`));
    }
  }
  out.push(
    reg.commissionList.published
      ? { rule: "commission-list", status: "note", code: "", detail: `Commission list of accredited CBAM verifiers published (checked ${reg.commissionList.checkedAt})` }
      : {
          rule: "commission-list",
          status: "note",
          code: "VERIFIER_PROVENANCE/COMMISSION_LIST_UNPUBLISHED",
          detail: `the Commission had not published its list of accredited CBAM verifiers when last checked (${reg.commissionList.checkedAt}); the record relies on the NAB's own register`,
        },
  );
  return out;
}

/** hashString of an accreditation SAID, for comparing a record with the allowlist entry. */
export const accreditationSaidHashOf = (said: string) => hashString(said);
