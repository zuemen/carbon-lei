// The watcher's detection-to-sync path (onDetected) on a hand-built KEL signed with a test key:
// evidence file contents, dry run vs --send, refusal of an unsigned event, and re-detection.
// The chain step and the tx log are injected, so nothing touches KERIA or a chain.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";
import { base64url } from "../../sdk/encoding.ts";
import { SAID_DUMMY, computeSaid } from "../../sdk/said.ts";
import { findRevocationSeal, type Json } from "../src/revocation.ts";
import { onDetected, type DetectionDeps, type Options } from "../src/watch.ts";

const CRED = "ELKomHMFqcJ-Gjt5uDRbe1MztQWaX0MyuwSC6I4B32qN";
const REV = "ETestRevEventSaid000000000000000000000000000";

function keriEvent(body: Json, labels: string[] = ["d"]): Json {
  const ev: Json = { v: "KERI10JSON000000_", ...body };
  for (const l of labels) ev[l] = SAID_DUMMY;
  ev.v = `KERI10JSON${new TextEncoder().encode(JSON.stringify(ev)).length.toString(16).padStart(6, "0")}_`;
  const said = computeSaid(ev);
  for (const l of labels) ev[l] = said;
  return ev;
}

const secret = ed25519.utils.randomSecretKey();
const key = "D" + base64url(new Uint8Array([0, ...ed25519.getPublicKey(secret)])).slice(1);
const sign = (ev: Json) => "-AAB" + base64url(new Uint8Array([0, 0, ...ed25519.sign(new TextEncoder().encode(JSON.stringify(ev)), secret)]));
const icp = keriEvent({ t: "icp", d: "", i: "", s: "0", kt: "1", k: [key], nt: "0", n: [], bt: "0", b: [], c: [], a: [] }, ["d", "i"]);
const ixn = keriEvent({ t: "ixn", d: "", i: icp.i, s: "1", p: icp.d, a: [{ i: CRED, s: "1", d: REV }] });
const signed = [
  { ked: icp, atc: sign(icp) },
  { ked: ixn, atc: sign(ixn) },
];

function options(send: boolean): Options {
  return {
    target: { credSaid: CRED, label: "ecr", issuerKey: "verifier", issuerPre: icp.i, holderKey: "auditor", holderPre: "EAuditor" },
    observerKey: "importer",
    intervalMs: 15_000,
    settleMs: 3_000,
    once: false,
    send,
    network: "sepolia",
  };
}

const observer = { key: "importer", aid: { prefix: "EImporter" } };
const ctx = { watchStartedAt: "2026-10-06T05:15:00.000Z", polls: 7 };

/** Injected side effects: a fake chain step (exit 0 unless overridden) and a tx log that has `tx` once the step ran. */
function deps(tx?: Json) {
  const run = vi.fn<DetectionDeps["run"]>(async () => 0);
  const d: DetectionDeps & { run: typeof run } = {
    evidenceDir: mkdtempSync(join(tmpdir(), "watch-test-")),
    run,
    txLog: () => (run.mock.calls.length ? tx : undefined),
  };
  return d;
}

const readEvidence = (d: DetectionDeps) => JSON.parse(readFileSync(join(d.evidenceDir, `revocation-${CRED}.json`), "utf8"));

describe("onDetected", () => {
  const hit = findRevocationSeal(signed, CRED, { issuer: icp.i })!;

  it("dry run: writes the evidence, does not call the chain step", async () => {
    const d = deps();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await onDetected(options(false), observer, hit, signed, ctx, d)).toBe(0);
    expect(d.run).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join("\n")).toContain("would call revokeAuditor");
    log.mockRestore();
    const ev = readEvidence(d);
    expect(ev).toMatchObject({
      credSAID: CRED,
      kelSeq: 1,
      seal: { i: CRED, s: "1", d: REV },
      revEventSAID: REV,
      issuer: { agent: "verifier", aid: icp.i },
      observer: { agent: "importer", aid: "EImporter" },
      polls: 7,
      watchStartedAt: ctx.watchStartedAt,
      checks: { saidRecomputed: true, sizeMatchesVersion: true, priorLinked: true, signatureValid: true },
      chainSync: { network: "sepolia", step: "revokeAuditor", sent: false },
    });
    expect(ev.event.raw).toBe(JSON.stringify(ixn));
    expect(ev.kelAttachment).toBe(signed[1].atc);
    expect(Date.parse(ev.detectedAt)).not.toBeNaN();
  });

  it("--send: runs revokeAuditor once and records the tx and the detection-to-block delay", async () => {
    const d = deps({ step: "revokeAuditor", result: "success", hash: "0xabc", block: 123, time: "2099-01-01T00:00:00Z" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await onDetected(options(true), observer, hit, signed, ctx, d)).toBe(0);
    vi.restoreAllMocks();
    expect(d.run).toHaveBeenCalledTimes(1);
    expect(d.run.mock.calls[0][1]).toBe("revokeAuditor");
    const ev = readEvidence(d);
    expect(ev.chainSync).toMatchObject({ sent: true, exitCode: 0, tx: { hash: "0xabc", block: 123, time: "2099-01-01T00:00:00Z" } });
    expect(ev.chainSync.secondsFromDetectionToBlock).toBe(Math.round((Date.parse("2099-01-01T00:00:00Z") - Date.parse(ev.detectedAt)) / 1000));
  });

  it("--send: retries a failed step, then records the attempts", async () => {
    let calls = 0;
    const d = deps({ step: "revokeAuditor", result: "success", hash: "0xdef", block: 124, time: "2099-01-01T00:00:00Z" });
    d.retryDelayMs = 0;
    d.run.mockImplementation(async () => (++calls < 2 ? 1 : 0));
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await onDetected(options(true), observer, hit, signed, ctx, d)).toBe(0);
    vi.restoreAllMocks();
    expect(d.run).toHaveBeenCalledTimes(2);
    expect(readEvidence(d).chainSync).toMatchObject({ sent: true, attempts: 2, exitCode: 0 });
  });

  it("--send: gives up after three failed attempts and exits non-zero", async () => {
    const d = deps();
    d.retryDelayMs = 0;
    d.run.mockImplementation(async () => 1);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await onDetected(options(true), observer, hit, signed, ctx, d)).toBe(1);
    vi.restoreAllMocks();
    expect(d.run).toHaveBeenCalledTimes(3);
    expect(readEvidence(d).chainSync).toMatchObject({ sent: true, attempts: 3, exitCode: 1, tx: null });
  });

  it("a credential without an on-chain step only gets evidence, even with --send", async () => {
    const d = deps();
    const o = options(true);
    o.target = { ...o.target, label: "accreditation" };
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await onDetected(o, observer, hit, signed, ctx, d)).toBe(0);
    vi.restoreAllMocks();
    expect(d.run).not.toHaveBeenCalled();
    expect(readEvidence(d).chainSync).toMatchObject({ step: null, sent: false });
  });

  it("--send: refuses an event whose signature does not verify", async () => {
    const unsigned = [signed[0], { ked: ixn }];
    const d = deps();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const h = findRevocationSeal(unsigned, CRED)!;
    expect(await onDetected(options(true), observer, h, unsigned, ctx, d)).toBe(1);
    vi.restoreAllMocks();
    expect(d.run).not.toHaveBeenCalled();
    const ev = readEvidence(d);
    expect(ev.checks.signatureValid).toBe(false);
    expect(ev.chainSync).toMatchObject({ sent: false, refused: "seal event failed its re-checks" });
  });

  it("re-detection of the same seal keeps the first detection time", async () => {
    const d = deps();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await onDetected(options(false), observer, hit, signed, ctx, d);
    const first = readEvidence(d).detectedAt;
    await new Promise((r) => setTimeout(r, 5));
    await onDetected(options(false), observer, hit, signed, { watchStartedAt: "2026-10-06T06:00:00.000Z", polls: 1 }, d);
    vi.restoreAllMocks();
    const ev = readEvidence(d);
    expect(ev.detectedAt).toBe(first);
    expect(ev.redetectedAt).not.toBe(first);
    expect(ev.watchStartedAt).toBe(ctx.watchStartedAt);
  });
});
