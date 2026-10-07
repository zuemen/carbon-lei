// Mutation testing for the two Solidity contracts, with a small mutator written for this repo.
// The contracts under contracts/src are never modified: every mutant is applied to a copy of the
// project in a temporary directory, and `forge build` + `forge test --fail-fast` run there.
//
// Usage:
//   node scripts/mutation-test.mjs --list                 # print the mutants, run nothing
//   node scripts/mutation-test.mjs [--jobs 4] [--timeout 600] [--only id,id] [--out file]
//                                  [--full-fuzz] [--keep] [--rerun earlier.json]
//   The recorded run: all mutants with reduced fuzz settings, then
//   `--rerun <that run's json> --full-fuzz` to rerun only the survivors, with the repository's
//   fuzz settings and any tests added since, and merge the results into one file.
//
// Operators: relational boundary (< <=, > >=), equality (== !=), logical (&& ||), arithmetic
// (+ -, += -=), removal of unary `!`, negation of an `if` condition, negation of a boolean
// return, deletion of an `if (...) revert` / `if (...) return` guard, deletion of a state write,
// deletion of an emit or a call statement, deletion of an access-control modifier, and the
// constant 0 replaced by 1. The set is representative, not exhaustive.
//
// Result per mutant: killed (a test failed), survived (all tests passed), compile_error (the
// mutant does not compile) or timeout (counted as killed). Equivalent mutants are listed in
// EQUIVALENT below, with the reason, after manual review.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = ["contracts/src/EmissionsClaimRegistry.sol", "contracts/src/VerifierAllowlist.sol"];

// Reduced fuzz settings for the mutant runs (the unit tests are unchanged). Survivors are rerun
// with the repository's own settings (--full-fuzz) before they are classified.
const FAST_FUZZ = { FOUNDRY_FUZZ_RUNS: "64", FOUNDRY_INVARIANT_RUNS: "32", FOUNDRY_INVARIANT_DEPTH: "64" };

// Mutants reviewed by hand and judged equivalent: same observable behaviour for every input.
// Key: `${file}:${line}:${operator}:${mutated line, trimmed}`.
const EQUIVALENT = {
  "contracts/src/EmissionsClaimRegistry.sol:225:relational:uint96 remaining = cs.claimedKg > rep.verifiedKg ? 0 : rep.verifiedKg - cs.claimedKg;":
    "The two expressions differ only when claimedKg == verifiedKg, and then verifiedKg - claimedKg is 0, the same value.",
  "contracts/src/EmissionsClaimRegistry.sol:306:relational:if (cs.latestReportKey != reportKey || cs.claimedKg > rep.verifiedKg) return 0;":
    "Differs only when claimedKg == verifiedKg; the next line then returns verifiedKg - claimedKg = 0, the same value.",
  "contracts/src/EmissionsClaimRegistry.sol:274:constant:if (unboundAt == 1 || t >= unboundAt) return false;":
    "A registered report whose ID is not the scope's current ID always has unboundAt >= registeredAt >= 1 (line 198 records it when the ID is moved off, and a retired ID cannot be registered again), so unboundAt == 0 is unreachable; when unboundAt == 1, t >= registeredAt >= 1 already gives t >= unboundAt.",
  "contracts/src/EmissionsClaimRegistry.sol:353:delete-if-revert:(line deleted)":
    "Defensive check: in branch (b) r.supersedes is credScopes[r.reportScopeKey][..].latestReportKey, which is only ever set (line 202) to a report stored with that same reportScopeKey, so the condition is always false.",
  "contracts/src/VerifierAllowlist.sol:228:negate-return:return !(super._grantRole(role, account));":
    "No caller in either contract or in OpenZeppelin's AccessControl uses the boolean returned by _grantRole (constructor, grantRole and _transferOwnership all discard it).",
};

// ------------------------------------------------------------------ args

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const JOBS = Number(opt("--jobs", "4"));
const TIMEOUT_S = Number(opt("--timeout", "600"));
const ONLY = opt("--only", "") ? new Set(opt("--only", "").split(",").map(Number)) : null;
const today = new Date().toISOString().slice(0, 10);
const OUT = resolve(ROOT, opt("--out", `docs/data/mutation-${today}.json`));

// ------------------------------------------------------------- generator

/** Code part of a line: comments and string literals blanked with spaces (same length). */
function codeMask(line) {
  let out = "";
  let inStr = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      out += " ";
      if (c === "\\") {
        out += " ";
        i++;
      } else if (c === inStr) inStr = null;
      continue;
    }
    if (c === "/" && line[i + 1] === "/") return out + " ".repeat(line.length - i);
    if (c === '"' || c === "'") {
      inStr = c;
      out += " ";
      continue;
    }
    out += c;
  }
  return out;
}

/** Index of the parenthesis that closes the one at `open` in the masked source, or -1. */
function matchParen(src, open) {
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") d++;
    else if (src[i] === ")" && --d === 0) return i;
  }
  return -1;
}

/** End index (inclusive) of the statement starting at `start`: the first `;` at depth 0. */
function statementEnd(src, start) {
  let d = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "{" || c === "[") d++;
    else if (c === ")" || c === "}" || c === "]") d--;
    else if (c === ";" && d === 0) return i;
  }
  return -1;
}

const TYPE_WORDS =
  /^(uint\d*|int\d*|address|bytes\d*|bool|string|InstitutionRecord|AddressBinding|AuditorRecord|ReportRecord|ReportScope|CredScope|Shipment|VerifierAllowlist|return|emit|if|else|revert|require|for|while|super)\b/;

function generate(file) {
  const text = readFileSync(join(ROOT, file), "utf8");
  const lines = text.split("\n");
  const masked = lines.map(codeMask);
  const src = masked.join("\n"); // same offsets as `text`
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (off) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const mutants = [];
  const add = (operator, start, end, replacement) => {
    // Keep line count: a deleted multi-line span is replaced by its newlines.
    const original = text.slice(start, end);
    const newlines = (original.match(/\n/g) || []).length;
    const repl = replacement + (replacement.includes("\n") ? "" : "\n".repeat(newlines));
    const mutated = text.slice(0, start) + repl + text.slice(end);
    const line = lineOf(start);
    const mutLines = mutated.split("\n");
    mutants.push({
      file,
      line,
      operator,
      original: lines[line - 1].trim(),
      mutated: mutLines[line - 1].trim() || "(line deleted)",
      originalSpan: original,
      source: mutated,
    });
  };

  // Function context: return type per offset, to find boolean returns.
  const boolFnRanges = [];
  for (const m of src.matchAll(/function\s+\w+\s*\([^)]*\)[^{;]*\{/g)) {
    const header = m[0];
    const open = m.index + header.length - 1;
    let d = 0;
    let close = open;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") d++;
      else if (src[i] === "}" && --d === 0) {
        close = i;
        break;
      }
    }
    if (/returns\s*\(\s*bool\s*\)/.test(header)) boolFnRanges.push([open, close]);
    // Access-control modifiers.
    for (const mod of header.matchAll(/\s(onlyOwner|onlyRole\(\w+\))/g)) {
      const s = m.index + mod.index;
      add("delete-modifier", s, s + mod[0].length, "");
    }
  }
  const inBoolFn = (off) => boolFnRanges.some(([a, b]) => off > a && off < b);

  // Token-level operators.
  const skipLine = (n) => /^\s*(pragma|import)\b/.test(lines[n - 1]);
  for (let i = 0; i < src.length; i++) {
    if (skipLine(lineOf(i))) continue;
    const two = src.slice(i, i + 2);
    const prev = src[i - 1];
    if (["=>", "<<", ">>", "++", "--"].includes(two)) {
      i++;
      continue;
    }
    const swaps = {
      "<=": ["<", "relational"],
      ">=": [">", "relational"],
      "==": ["!=", "equality"],
      "!=": ["==", "equality"],
      "&&": ["||", "logical"],
      "||": ["&&", "logical"],
      "+=": ["-=", "arithmetic"],
      "-=": ["+=", "arithmetic"],
    };
    if (swaps[two]) {
      add(swaps[two][1], i, i + 2, swaps[two][0]);
      i++;
      continue;
    }
    const c = src[i];
    const next = src[i + 1];
    if ((c === "<" || c === ">") && next !== "=" && prev !== "=") add("relational", i, i + 1, c + "=");
    else if ((c === "+" || c === "-") && next !== "=" && /[\w)\]\s]/.test(prev ?? "")) {
      // binary only: previous non-space char is an operand
      const before = src.slice(0, i).trimEnd();
      if (/[\w)\]]$/.test(before)) add("arithmetic", i, i + 1, c === "+" ? "-" : "+");
    } else if (c === "!" && next !== "=") add("remove-not", i, i + 1, "");
  }

  // Statements.
  for (const m of src.matchAll(/\bif\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(src, open);
    const after = src.slice(close + 1).match(/^\s*(\{\s*)?(\w+)/);
    const cond = text.slice(open + 1, close);
    add("negate-if", open, close + 1, `(!(${cond}))`);
    if (!after) continue;
    const kind = after[2];
    if (kind === "revert" || kind === "return" || after[1] === undefined) {
      // whole if statement (no else in these guards)
      let end;
      if (after[1] !== undefined) {
        // braces: find matching }
        let d = 0;
        for (let k = close + 1; k < src.length; k++) {
          if (src[k] === "{") d++;
          else if (src[k] === "}" && --d === 0) {
            end = k;
            break;
          }
        }
        if (/^\s*else\b/.test(src.slice(end + 1))) continue;
      } else end = statementEnd(src, close + 1);
      const opname = kind === "revert" ? "delete-if-revert" : kind === "return" ? "delete-if-return" : "delete-guarded-call";
      if (src.slice(m.index - 5, m.index).includes("else")) continue;
      add(opname, m.index, end + 1, "");
    }
  }
  // Boolean returns.
  for (const m of src.matchAll(/\breturn\s+([^;]+);/g)) {
    if (!inBoolFn(m.index)) continue;
    const expr = text.slice(m.index + m[0].indexOf(m[1]), m.index + m[0].indexOf(m[1]) + m[1].length);
    const s = m.index;
    const e = m.index + m[0].length;
    if (expr === "true") add("negate-return", s, e, "return false;");
    else if (expr === "false") add("negate-return", s, e, "return true;");
    else add("negate-return", s, e, `return !(${expr});`);
  }
  // Assignments, emits and call statements (start of statement = after ; { or }).
  for (const m of src.matchAll(/(?<=[;{}]\s*)(?=[A-Za-z_(])/g)) {
    const s = m.index;
    const head = src.slice(s, s + 40);
    if (TYPE_WORDS.test(head) && !/^(emit|super)\b/.test(head)) continue;
    const end = statementEnd(src, s);
    if (end < 0) continue;
    const stmt = src.slice(s, end + 1);
    // inside a function body only
    const lineText = lines[lineOf(s) - 1];
    if (/^\s*(function|constructor|contract|mapping|event|error|struct|modifier|\/\/)/.test(lineText)) continue;
    if (/^emit\b/.test(stmt)) add("delete-emit", s, end + 1, "");
    else if (/^[\w.[\]()\s,]+?(\+=|-=|(?<![=!<>])=(?!=))/.test(stmt) && !/^\w+\s*\(/.test(stmt.replace(/^\(/, "x(")))
      add("delete-assignment", s, end + 1, "");
    else if (/^\(\s*\w+\s*,/.test(stmt) && /(?<![=!<>])=(?!=)/.test(stmt)) add("delete-assignment", s, end + 1, "");
    else if (/^(super\.)?\w+\s*\(/.test(stmt)) add("delete-call", s, end + 1, "");
  }
  // Constant 0 -> 1.
  for (const m of src.matchAll(/(?<![\w.])0(?![\w.x])/g)) {
    if (skipLine(lineOf(m.index))) continue;
    const pre = src.slice(m.index - 8, m.index);
    if (/bytes32\($/.test(pre)) add("constant", m.index, m.index + 1, "uint256(1)");
    else add("constant", m.index, m.index + 1, "1");
  }
  return mutants;
}

function allMutants() {
  const list = TARGETS.flatMap(generate);
  // de-duplicate identical sources
  const seen = new Set();
  const out = [];
  for (const m of list) {
    if (seen.has(m.source)) continue;
    seen.add(m.source);
    out.push(m);
  }
  out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.operator.localeCompare(b.operator));
  out.forEach((m, i) => {
    m.id = i + 1;
    m.key = `${m.file}:${m.line}:${m.operator}:${m.mutated}`;
  });
  return out;
}

// ---------------------------------------------------------------- runner

function run(cmd, argv, cwd, env, timeoutS) {
  return new Promise((res) => {
    const t0 = Date.now();
    const p = spawn(cmd, argv, { cwd, env: { ...process.env, ...env }, detached: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-p.pid, "SIGKILL");
      } catch {}
    }, timeoutS * 1000);
    p.on("close", (code) => {
      clearTimeout(timer);
      res({ code, timedOut, out, seconds: (Date.now() - t0) / 1000 });
    });
  });
}

function makeWorkspace(baseDir, n) {
  const ws = join(baseDir, `ws${n}`);
  mkdirSync(join(ws, "contracts"), { recursive: true });
  cpSync(join(ROOT, "foundry.toml"), join(ws, "foundry.toml"));
  for (const d of ["src", "test", "script", "deployments"]) cpSync(join(ROOT, "contracts", d), join(ws, "contracts", d), { recursive: true });
  cpSync(join(ROOT, "fixtures"), join(ws, "fixtures"), { recursive: true });
  symlinkSync(join(ROOT, "contracts", "lib"), join(ws, "contracts", "lib"));
  return ws;
}

function firstFailure(out) {
  const m = out.match(/\[FAIL[^\]]*\]\s*([^\n]+)/);
  return m ? m[1].trim().slice(0, 200) : null;
}

async function evaluate(ws, m, env) {
  const target = join(ws, m.file);
  const original = readFileSync(join(ROOT, m.file), "utf8");
  writeFileSync(target, m.source);
  try {
    const b = await run("forge", ["build"], ws, env, TIMEOUT_S);
    if (b.timedOut) return { result: "timeout", stage: "build", seconds: b.seconds };
    if (b.code !== 0) {
      const err = (b.out.match(/Error[^\n]*\n[^\n]*/) || [""])[0].replace(/\s+/g, " ").slice(0, 200);
      return { result: "compile_error", detail: err, seconds: b.seconds };
    }
    const t = await run("forge", ["test", "--fail-fast"], ws, env, TIMEOUT_S);
    const seconds = b.seconds + t.seconds;
    if (t.timedOut) return { result: "timeout", stage: "test", seconds };
    if (t.code === 0) return { result: "survived", seconds };
    return { result: "killed", killedBy: firstFailure(t.out), seconds };
  } finally {
    writeFileSync(target, original);
  }
}

async function main() {
  const mutants = allMutants();
  if (flag("--list")) {
    for (const m of mutants) console.log(`${m.id}\t${m.file.split("/").pop()}:${m.line}\t${m.operator}\t${m.original}  =>  ${m.mutated}`);
    console.log(`${mutants.length} mutants`);
    return;
  }
  // --rerun <json>: rerun only the survivors of an earlier run against the current tests and
  // merge. Mutants killed earlier stay killed: tests are only ever added, never changed.
  const RERUN = opt("--rerun", "");
  const previous = RERUN ? JSON.parse(readFileSync(resolve(ROOT, RERUN), "utf8")) : null;
  if (previous) {
    const prevKeys = previous.mutants.map((r) => `${r.file}:${r.line}:${r.operator}:${r.mutated}`);
    const nowKeys = mutants.map((m) => m.key);
    if (prevKeys.join("\n") !== nowKeys.join("\n")) throw new Error("mutant set changed since the earlier run");
  }
  const rerunIds = previous ? new Set(previous.mutants.filter((r) => r.result === "survived").map((r) => r.id)) : null;
  const todo = mutants.filter((m) => (!ONLY || ONLY.has(m.id)) && (!rerunIds || rerunIds.has(m.id)));
  const env = flag("--full-fuzz") ? {} : FAST_FUZZ;
  const base = mkdtempSync(join(tmpdir(), "carbonlei-mut-"));
  const jobs = Math.min(JOBS, todo.length);
  const wss = Array.from({ length: jobs }, (_, i) => makeWorkspace(base, i));
  console.error(`workspaces in ${base}; ${todo.length} mutants, ${jobs} jobs, timeout ${TIMEOUT_S}s`);

  // Baseline: the unmodified copy must build and pass with the same settings.
  const baseline = await Promise.all(
    wss.map(async (ws) => {
      const b = await run("forge", ["build"], ws, env, TIMEOUT_S);
      const t = b.code === 0 ? await run("forge", ["test", "--fail-fast"], ws, env, TIMEOUT_S) : b;
      return { ok: b.code === 0 && t.code === 0, seconds: b.seconds + (t === b ? 0 : t.seconds), out: t.out };
    }),
  );
  if (!baseline.every((b) => b.ok)) {
    console.error(baseline.find((b) => !b.ok).out.slice(-3000));
    throw new Error("baseline failed");
  }
  console.error(`baseline ok (${baseline[0].seconds.toFixed(0)} s)`);

  const results = [];
  let next = 0;
  await Promise.all(
    wss.map(async (ws) => {
      while (next < todo.length) {
        const m = todo[next++];
        const r = await evaluate(ws, m, env);
        const eq = EQUIVALENT[m.key];
        const rec = {
          id: m.id,
          file: m.file,
          line: m.line,
          operator: m.operator,
          original: m.original,
          mutated: m.mutated,
          ...r,
          seconds: Number(r.seconds.toFixed(1)),
          ...(eq && r.result === "survived" ? { equivalent: eq } : {}),
        };
        results.push(rec);
        console.error(`[${results.length}/${todo.length}] #${m.id} ${m.file.split("/").pop()}:${m.line} ${m.operator}: ${r.result}${r.killedBy ? ` (${r.killedBy})` : ""}`);
      }
    }),
  );
  if (previous) {
    const byId = new Map(results.map((r) => [r.id, r]));
    const merged = previous.mutants.map((p) => {
      const r = byId.get(p.id);
      if (!r) return p;
      return { ...r, firstRun: { result: p.result, fuzz: previous.fuzz } };
    });
    results.length = 0;
    results.push(...merged);
  }
  results.sort((a, b) => a.id - b.id);
  if (!flag("--keep")) rmSync(base, { recursive: true, force: true });

  const count = (f) => results.filter(f).length;
  const killed = count((r) => r.result === "killed" || r.result === "timeout");
  const compileErrors = count((r) => r.result === "compile_error");
  const equivalent = count((r) => r.result === "survived" && r.equivalent);
  const survived = count((r) => r.result === "survived" && !r.equivalent);
  const denom = results.length - equivalent - compileErrors;
  const summary = {
    total: results.length,
    killed,
    timeouts: count((r) => r.result === "timeout"),
    survived,
    equivalent,
    compileErrors,
    score: denom ? Number((killed / denom).toFixed(4)) : null,
    scoreFormula: "killed / (total - equivalent - compile_error); timeouts count as killed",
  };
  const doc = {
    generatedAt: new Date().toISOString(),
    tool: "scripts/mutation-test.mjs (mutator written for this repo; not exhaustive)",
    targets: TARGETS,
    fuzz: previous
      ? {
          firstRun: previous.fuzz,
          survivorsRerun: flag("--full-fuzz") ? "repository settings (foundry.toml)" : FAST_FUZZ,
        }
      : flag("--full-fuzz")
        ? "repository settings (foundry.toml)"
        : FAST_FUZZ,
    command: "forge build && forge test --fail-fast, in a temporary copy of the project",
    ...(previous ? { firstRunAt: previous.generatedAt, firstRunSummary: previous.summary } : {}),
    forge: (await run("forge", ["--version"], ROOT, {}, 30)).out.split("\n")[0],
    summary,
    mutants: results,
  };
  if (!ONLY) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n");
    console.error(`wrote ${OUT}`);
  }
  console.log(JSON.stringify(summary, null, 2));
  for (const r of results.filter((r) => r.result === "survived"))
    console.log(`survived #${r.id} ${r.file}:${r.line} ${r.operator}: ${r.original} => ${r.mutated}${r.equivalent ? ` [equivalent: ${r.equivalent}]` : ""}`);
}

await main();
